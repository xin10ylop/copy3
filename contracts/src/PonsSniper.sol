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
/// @dev    Buys are paid from this contract's ETH balance (fund it via `receive`); burst txs
///         should carry `msg.value = 0` so that every member stays executable and the
///         executor's nonces are always consumed.
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

    event Sniped(address indexed token, address indexed curve, uint256 quoteIn, uint256 tokensOut, uint256 taxBps);
    event Exited(address indexed token, address indexed curve, uint256 tokensIn, uint256 quoteOut);
    event OperatorSet(address indexed operator, bool enabled);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    // ---------------------------------------------------------------- curve call encoding
    /// @dev buy(uint256 quoteIn, uint256 minTokensOut, address recipient)   — RESEARCH §3, §7.1
    bytes4 internal constant CURVE_BUY = 0x59a87bc1;
    /// @dev sell(uint256 tokensIn, uint256 minQuoteOut, address recipient)  — RESEARCH §3, §7.1
    bytes4 internal constant CURVE_SELL = 0xd04c6983;

    // ---------------------------------------------------------------- storage
    address public owner;
    mapping(address => bool) public operators;
    mapping(address => bool) public bought;
    /// @dev true on Arbitrum Nitro chains: deadlines are L2 block numbers from ArbSys.
    bool public immutable arbBlockNumbers;

    constructor(address owner_, address operator_) {
        if (owner_ == address(0)) revert ZeroAddress();
        owner = owner_;
        emit OwnershipTransferred(address(0), owner_);
        if (operator_ != address(0)) {
            operators[operator_] = true;
            emit OperatorSet(operator_, true);
        }
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

    receive() external payable {}

    // ---------------------------------------------------------------- hot path
    /// @notice Buy `token` on `curve` once, only if the snipe tax for this contract is ≤ maxTaxBps.
    /// @dev Check order keeps revert paths cheap: deadline, auth, bought, tax, then buy.
    function snipe(
        address curve,
        address token,
        uint256 quoteIn,
        uint256 minTokensOut,
        uint16 maxTaxBps,
        uint64 deadlineBlock
    ) external payable {
        if (_blockNumber() > deadlineBlock) revert Expired();
        // operators first: the burst key is an operator, so the common case costs one SLOAD
        if (!operators[msg.sender] && msg.sender != owner) revert NotOperator();
        if (bought[token]) revert AlreadyBought();
        uint256 tax = IPonsCurve(curve).currentSnipeTaxBps(address(this));
        if (tax > maxTaxBps) revert TaxTooHigh(tax);
        bought[token] = true;
        uint256 before = IERC20Min(token).balanceOf(address(this));
        _curveBuy(curve, quoteIn, minTokensOut);
        uint256 tokensOut = IERC20Min(token).balanceOf(address(this)) - before;
        _approveMax(token, curve);
        emit Sniped(token, curve, quoteIn, tokensOut, tax);
    }

    /// @notice Sell `tokensIn` (0 = everything held) and forward the ETH proceeds to the owner.
    function exit(address curve, address token, uint256 tokensIn, uint256 minQuoteOut)
        external
        onlyOperator
        returns (uint256 quoteOut)
    {
        if (tokensIn == 0) tokensIn = IERC20Min(token).balanceOf(address(this));
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

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    /// @notice Send `amount` wei (0 = all) to `to`.
    function sweepEth(address payable to, uint256 amount) external onlyOwner {
        if (amount == 0) amount = address(this).balance;
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
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
        uint256 before = address(this).balance;
        _curveSell(curve, tokensIn, minQuoteOut);
        quoteOut = address(this).balance - before;
        (bool ok,) = owner.call{value: quoteOut}("");
        if (!ok) revert TransferFailed();
        emit Exited(token, curve, tokensIn, quoteOut);
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
