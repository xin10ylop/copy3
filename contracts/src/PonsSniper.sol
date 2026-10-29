// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal view of a Pons V2 bonding curve (selectors measured, docs/RESEARCH.md §3).
interface IPonsCurve {
    function currentSnipeTaxBps(address account) external view returns (uint256);
}

interface IERC20Min {
    function balanceOf(address account) external view returns (uint256);
}

/// @dev Arbitrum precompile; on Nitro chains `block.number` is the (approximate) L1 block.
interface IArbSys {
    function arbBlockNumber() external view returns (uint256);
}

/// @title PonsSniper
/// @notice Idempotent, tax-gated buyer used by the HoodSniper burst executor
///         (docs/ARCHITECTURE.md §3). Every burst member calls `snipe`; members that land in
///         a launch-second block revert cheaply on `TaxTooHigh`, members that land after a
///         successful sibling revert on `AlreadyBought`, exactly one buy executes. Bought
///         tokens stay here, pre-approved to the curve, so `exit` is a single call.
/// @dev    Buys are paid from this contract's ETH balance (fund it with a plain ETH transfer,
///         `receive`); burst txs should carry `msg.value = 0` so that every member stays
///         executable and the executor's nonces are always consumed. Sale proceeds are forwarded
///         to `treasury` (address(0) = the current owner, address(this) = compound in place); if
///         the receiver cannot take ETH they stay here and the owner sweeps them — an exit never
///         reverts because of the receiver.
///         C-1 (owner = a wallet without custom calldata, e.g. Phantom): every operator and the
///         treasury are set in the constructor, and a plain 0-ETH transfer from the owner sweeps
///         the whole ETH balance to the owner (`receive`). ERC-20 positions are NOT swept that
///         way: recovering tokens (`sweepToken`/`rescue`), changing caps, operators or the
///         treasury still needs a calldata-capable owner wallet.
///         Operator keys are hot: they can only buy real Pons curves (verified against the
///         immutable factory), at most `maxQuoteIn` per token, once per token, within a
///         decaying spend budget (at most `maxSpendPerWindow` at once, refilling at
///         `maxSpendPerWindow / spendWindow` per second), only until the burst's block AND
///         wall-clock deadlines, and they can only sell into those curves; they cannot move ETH
///         or tokens anywhere else.
contract PonsSniper {
    // ---------------------------------------------------------------- errors / events
    error NotOwner();
    error NotOperator();
    error Expired();
    error AlreadyBought();
    error TaxTooHigh(uint256 tax);
    error NothingToSell();
    error TransferFailed();
    error ZeroAddress();
    error MaxTaxTooHigh();
    error QuoteTooLarge(uint256 quoteIn, uint256 maxQuoteIn);
    error UnknownCurve();
    error NotPendingOwner();
    error SpendLimitExceeded(uint256 spent, uint256 quoteIn, uint256 maxSpend);
    error InvalidSpendWindow();
    error NoOperators();
    error NothingToSweep();

    event Sniped(address indexed token, address indexed curve, uint256 quoteIn, uint256 tokensOut, uint256 taxBps);
    event Exited(address indexed token, address indexed curve, uint256 tokensIn, uint256 quoteOut);
    event OperatorSet(address indexed operator, bool enabled);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event MaxQuoteInSet(uint256 maxQuoteIn);
    event SpendLimitSet(uint256 maxSpendPerWindow, uint256 spendWindow);
    event SpendLimitDisabled();
    event TreasurySet(address indexed treasury);
    event ProceedsSent(address indexed to, uint256 amount);
    event ProceedsHeld(address indexed to, uint256 amount);
    event Swept(address indexed to, uint256 amount);

    // ---------------------------------------------------------------- curve call encoding
    /// @dev buy(uint256 quoteIn, uint256 minTokensOut, address recipient)   — RESEARCH §3, §7.1
    bytes4 internal constant CURVE_BUY = 0x59a87bc1;
    /// @dev sell(uint256 tokensIn, uint256 minQuoteOut, address recipient)  — RESEARCH §3, §7.1
    bytes4 internal constant CURVE_SELL = 0xd04c6983;
    /// @dev factory getLaunchedToken(address) → LaunchInfo{token, curve, deployer, …} (15 static words)
    bytes4 internal constant FACTORY_GET_LAUNCHED = 0x3cf28b5a;
    /// @dev the snipe tax is 9900 in the launch second; a cap at/above it disables the gate
    uint256 internal constant TAX_CAP_LIMIT = 9900;
    /// @dev gas forwarded with the proceeds (enough for an EOA, a Safe or a splitter; a receiver
    ///      that burns more cannot make the exit run out of gas)
    uint256 internal constant PROCEEDS_GAS = 50_000;

    // ---------------------------------------------------------------- storage
    address public owner; // packed with maxQuoteIn (one slot)
    uint96 public maxQuoteIn;
    /// @dev N4 / NEW-5: a stolen operator key can buy a curve it controls (its own real Pons
    ///      launch) and sandwich it; per snipe that costs at most maxQuoteIn, and this DECAYING
    ///      budget (a leaky bucket) caps the total: `spendLevel` drains at
    ///      `maxSpendPerWindow / spendWindow` wei per second and a buy must keep it at or below
    ///      `maxSpendPerWindow`. So at most `maxSpendPerWindow` can be bought at once and at most
    ///      `maxSpendPerWindow × (1 + t / spendWindow)` in ANY interval of t seconds (no 2× burst
    ///      across a window boundary). `spendWindow == 0` only via `disableSpendLimit()`.
    uint96 public maxSpendPerWindow; // packed with spendWindow (one slot)
    uint32 public spendWindow;
    uint64 public spendUpdatedAt; // packed with spendLevel (one slot)
    uint96 public spendLevel;
    address public pendingOwner;
    /// @dev receiver of exit proceeds; address(0) = the current owner, address(this) = keep here
    address payable public treasury;
    mapping(address => bool) public operators;
    mapping(address => bool) public bought;
    /// @dev true on Arbitrum Nitro chains: deadlines are L2 block numbers from ArbSys.
    bool public immutable arbBlockNumbers;
    /// @dev PonsV2LaunchFactory: the only source of truth for token → curve.
    address public immutable factory;

    /// @param operators_ every hot key (exit key + burst keys); at least one, none zero. The
    ///        owner may also be listed (it can snipe/exit anyway).
    /// @param treasury_ receiver of exit proceeds: address(0) = the owner, the (predicted)
    ///        address of this contract = keep them here and compound.
    /// @dev C-1: everything an owner without calldata (Phantom) could not set later is set here.
    constructor(
        address owner_,
        address[] memory operators_,
        address treasury_,
        address factory_,
        uint96 maxQuoteIn_,
        uint96 maxSpendPerWindow_,
        uint32 spendWindow_
    ) {
        if (owner_ == address(0) || factory_ == address(0)) revert ZeroAddress();
        if (spendWindow_ == 0) revert InvalidSpendWindow(); // "off" is an explicit disableSpendLimit()
        if (operators_.length == 0) revert NoOperators();
        owner = owner_;
        factory = factory_;
        maxQuoteIn = maxQuoteIn_;
        maxSpendPerWindow = maxSpendPerWindow_;
        spendWindow = spendWindow_;
        spendUpdatedAt = uint64(block.timestamp);
        emit OwnershipTransferred(address(0), owner_);
        emit MaxQuoteInSet(maxQuoteIn_);
        emit SpendLimitSet(maxSpendPerWindow_, spendWindow_);
        for (uint256 i; i < operators_.length; ++i) {
            address op = operators_[i];
            if (op == address(0)) revert ZeroAddress();
            operators[op] = true;
            emit OperatorSet(op, true);
        }
        treasury = payable(treasury_);
        emit TreasurySet(treasury_);
        uint256 id = block.chainid;
        // Robinhood Chain mainnet/testnet, Arbitrum One / Nova / Sepolia
        arbBlockNumbers = id == 4663 || id == 46630 || id == 42161 || id == 42170 || id == 421614;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyOperator() {
        if (!operators[msg.sender] && msg.sender != owner) revert NotOperator();
        _;
    }

    /// @notice Plain ETH transfers. `msg.value > 0` (anyone, incl. curve sale proceeds) funds the
    ///         contract. `msg.value == 0` from the OWNER sweeps the whole ETH balance to the owner
    ///         (C-1: the withdraw button of a wallet that cannot send calldata) and reverts
    ///         `NothingToSweep` when the balance is 0, so the wallet sees a failure instead of a
    ///         silent no-op. `msg.value == 0` from anyone else reverts `NotOwner` (no state change).
    /// @dev Funding stays the cheap first branch. Tokens are not swept here: use `sweepToken`.
    receive() external payable {
        if (msg.value != 0) return;
        if (msg.sender != owner) revert NotOwner();
        uint256 amount = address(this).balance;
        if (amount == 0) revert NothingToSweep();
        (bool ok,) = payable(msg.sender).call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit Swept(msg.sender, amount);
    }

    // ---------------------------------------------------------------- hot path
    /// @notice Buy `token` on `curve` once, only if the snipe tax for this contract is ≤ maxTaxBps.
    /// @dev Check order keeps revert paths cheap: deadlines, tax cap, auth, bought, tax; the buy
    ///      path then checks maxQuoteIn, the spend budget and that `curve` is the factory's curve
    ///      for `token`. NEW-3: `deadlineTs` (wall clock, the executor passes launch ts + 3) stops a
    ///      member held back by a stalled sequencer from buying long after the launch: while no
    ///      blocks are produced the L2 block number does not advance, the timestamp does.
    function snipe(
        address curve,
        address token,
        uint256 quoteIn,
        uint256 minTokensOut,
        uint16 maxTaxBps,
        uint64 deadlineBlock,
        uint64 deadlineTs
    ) external payable {
        if (block.timestamp > deadlineTs || _blockNumber() > deadlineBlock) revert Expired();
        if (maxTaxBps >= TAX_CAP_LIMIT) revert MaxTaxTooHigh();
        // operators first: the burst key is an operator, so the common case costs one SLOAD
        if (!operators[msg.sender] && msg.sender != owner) revert NotOperator();
        if (bought[token]) revert AlreadyBought();
        uint256 tax = IPonsCurve(curve).currentSnipeTaxBps(address(this));
        if (tax > maxTaxBps) revert TaxTooHigh(tax);
        if (quoteIn > maxQuoteIn) revert QuoteTooLarge(quoteIn, maxQuoteIn);
        _spend(quoteIn);
        _checkCurve(token, curve);
        bought[token] = true;
        uint256 before = IERC20Min(token).balanceOf(address(this));
        _curveBuy(curve, quoteIn, minTokensOut);
        uint256 tokensOut = IERC20Min(token).balanceOf(address(this)) - before;
        _approveMax(token, curve);
        emit Sniped(token, curve, quoteIn, tokensOut, tax);
    }

    /// @notice Sell `tokensIn` (> 0; 0 reverts `NothingToSell`, use `exitAll`) of `token` on its
    ///         factory curve; proceeds go to the treasury.
    function exit(address curve, address token, uint256 tokensIn, uint256 minQuoteOut)
        external
        onlyOperator
        returns (uint256 quoteOut)
    {
        quoteOut = _exit(curve, token, tokensIn, minQuoteOut);
    }

    /// @notice Sell the whole balance of `token`.
    function exitAll(address curve, address token, uint256 minQuoteOut) external onlyOperator returns (uint256) {
        return _exit(curve, token, IERC20Min(token).balanceOf(address(this)), minQuoteOut);
    }

    // ---------------------------------------------------------------- admin
    function setOperator(address operator, bool enabled) external onlyOwner {
        operators[operator] = enabled;
        emit OperatorSet(operator, enabled);
    }

    /// @notice Where exit proceeds go (address(0) = owner, this contract = compound in place).
    function setTreasury(address payable t) external onlyOwner {
        treasury = t;
        emit TreasurySet(t);
    }

    /// @notice Decaying buy budget: at most `maxSpend` wei of quoteIn at once, refilling at
    ///         `maxSpend / window` per second. `window` must be > 0 (`setSpendLimit(0, 1)` is the
    ///         buy stop; turning the budget off is the separate `disableSpendLimit()`). The level
    ///         spent so far is carried over (decayed under the old parameters; 0 if it was off).
    function setSpendLimit(uint96 maxSpend, uint32 window) external onlyOwner {
        if (window == 0) revert InvalidSpendWindow();
        uint256 w = spendWindow;
        spendLevel = uint96(w == 0 ? 0 : _decayedLevel(w, maxSpendPerWindow));
        spendUpdatedAt = uint64(block.timestamp);
        maxSpendPerWindow = maxSpend;
        spendWindow = window;
        emit SpendLimitSet(maxSpend, window);
    }

    /// @notice Turn the spend budget OFF (explicit; `setSpendLimit` re-enables it).
    function disableSpendLimit() external onlyOwner {
        spendWindow = 0;
        emit SpendLimitDisabled();
    }

    /// @notice What `snipe` may still spend right now (type(uint256).max when the budget is off).
    function spendAvailable() external view returns (uint256) {
        uint256 w = spendWindow;
        if (w == 0) return type(uint256).max;
        uint256 limit = maxSpendPerWindow;
        uint256 level = _decayedLevel(w, limit);
        return level >= limit ? 0 : limit - level;
    }

    function setMaxQuoteIn(uint96 v) external onlyOwner {
        maxQuoteIn = v;
        emit MaxQuoteInSet(v);
    }

    /// @notice Two-step ownership: the new owner must `acceptOwnership`.
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotPendingOwner();
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }

    /// @notice Send `amount` wei (0 = all) to `to` (the calldata variant of the 0-ETH owner sweep).
    function sweepEth(address payable to, uint256 amount) external onlyOwner {
        if (amount == 0) amount = address(this).balance;
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit Swept(to, amount);
    }

    /// @notice Send `amount` (0 = all) of `token` to `to`.
    function sweepToken(address token, address to, uint256 amount) external onlyOwner {
        if (amount == 0) amount = IERC20Min(token).balanceOf(address(this));
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(0xa9059cbb, to, amount));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }

    /// @notice Arbitrary call (stuck funds, manual approvals, reset `bought` via a re-deploy, ...).
    function rescue(address target, uint256 value, bytes calldata data) external onlyOwner returns (bytes memory) {
        (bool ok, bytes memory ret) = target.call{value: value}(data);
        if (!ok) _bubble(ret);
        return ret;
    }

    // ---------------------------------------------------------------- internals
    /// @dev The ONLY place the curve buy is encoded. Change here if live verification differs.
    function _curveBuy(address curve, uint256 quoteIn, uint256 minTokensOut) internal {
        (bool ok, bytes memory ret) =
            curve.call{value: quoteIn}(abi.encodeWithSelector(CURVE_BUY, quoteIn, minTokensOut, address(this)));
        if (!ok) _bubble(ret);
    }

    /// @dev The ONLY place the curve sell is encoded. Change here if live verification differs.
    function _curveSell(address curve, uint256 tokensIn, uint256 minQuoteOut) internal {
        (bool ok, bytes memory ret) =
            curve.call(abi.encodeWithSelector(CURVE_SELL, tokensIn, minQuoteOut, address(this)));
        if (!ok) _bubble(ret);
    }

    function _exit(address curve, address token, uint256 tokensIn, uint256 minQuoteOut)
        internal
        returns (uint256 quoteOut)
    {
        if (tokensIn == 0) revert NothingToSell();
        _checkCurve(token, curve);
        uint256 before = address(this).balance;
        _curveSell(curve, tokensIn, minQuoteOut);
        quoteOut = address(this).balance - before;
        emit Exited(token, curve, tokensIn, quoteOut);
        _forward(quoteOut);
    }

    /// @dev Pay the proceeds to the treasury; on failure keep them (sweepable), never revert.
    function _forward(uint256 amount) internal {
        address payable to = treasury == address(0) ? payable(owner) : treasury;
        if (amount == 0 || to == address(this)) return;
        (bool ok,) = to.call{value: amount, gas: PROCEEDS_GAS}("");
        if (ok) emit ProceedsSent(to, amount);
        else emit ProceedsHeld(to, amount);
    }

    /// @dev N4 / NEW-5: charge `quoteIn` against the decaying budget. Before adding, the level
    ///      drains by `limit × elapsed / window` (floored at 0), so the bound holds continuously.
    function _spend(uint256 quoteIn) internal {
        uint256 window = spendWindow;
        if (window == 0) return;
        uint256 limit = maxSpendPerWindow;
        uint256 level = _decayedLevel(window, limit);
        if (level + quoteIn > limit) revert SpendLimitExceeded(level, quoteIn, limit);
        spendLevel = uint96(level + quoteIn);
        spendUpdatedAt = uint64(block.timestamp);
    }

    /// @dev `spendLevel` drained for the time since `spendUpdatedAt` (limit ≤ 2^96, elapsed ≤ 2^64: no overflow).
    function _decayedLevel(uint256 window, uint256 limit) internal view returns (uint256) {
        uint256 level = spendLevel;
        uint256 leak = (limit * (block.timestamp - spendUpdatedAt)) / window;
        return level > leak ? level - leak : 0;
    }

    /// @dev `curve` must be the factory's curve for `token` (a hot operator key cannot point the
    ///      contract's ETH at an arbitrary address).
    function _checkCurve(address token, address curve) internal view {
        (bool ok, bytes memory ret) = factory.staticcall(abi.encodeWithSelector(FACTORY_GET_LAUNCHED, token));
        if (!ok || ret.length < 64) revert UnknownCurve();
        (address t, address c) = abi.decode(ret, (address, address));
        if (t != token || c != curve || c == address(0)) revert UnknownCurve();
    }

    function _approveMax(address token, address spender) internal {
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(0x095ea7b3, spender, type(uint256).max));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }

    function _blockNumber() internal view returns (uint256) {
        return arbBlockNumbers ? IArbSys(address(100)).arbBlockNumber() : block.number;
    }

    function _bubble(bytes memory ret) internal pure {
        assembly {
            revert(add(ret, 32), mload(ret))
        }
    }
}
