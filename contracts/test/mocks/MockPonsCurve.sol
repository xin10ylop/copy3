// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal ERC-20 minted to the curve (Pons mints 1e9 tokens into each curve).
contract MockToken {
    string public name = "Mock";
    string public symbol = "MOCK";
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(address to, uint256 supply) {
        totalSupply = supply;
        balanceOf[to] = supply;
        emit Transfer(address(0), to, supply);
    }

    function transfer(address to, uint256 v) external returns (bool) {
        _move(msg.sender, to, v);
        return true;
    }

    function approve(address s, uint256 v) external returns (bool) {
        allowance[msg.sender][s] = v;
        emit Approval(msg.sender, s, v);
        return true;
    }

    function transferFrom(address f, address to, uint256 v) external returns (bool) {
        uint256 a = allowance[f][msg.sender];
        if (a != type(uint256).max) {
            require(a >= v, "allowance");
            allowance[f][msg.sender] = a - v;
        }
        _move(f, to, v);
        return true;
    }

    function _move(address f, address to, uint256 v) internal {
        require(balanceOf[f] >= v, "balance");
        balanceOf[f] -= v;
        balanceOf[to] += v;
        emit Transfer(f, to, v);
    }
}

/// @notice Pons V2 curve semantics as measured on the AMLIL launch (docs/EXAMPLES.md):
///   constant product on (phantomQuote + realQuoteReserve, tokenReserve);
///   buy: fee = quoteIn·feeBps + snipeTax, tax = quoteIn·creatorTaxBps, net = quoteIn − fee − tax;
///   CurveBuy(buyer, recipient, quoteIn, tokensOut, fee, tax) + SnipeTaxCharged(recipient, snipeTax);
///   sell: gross = Q·in/(T+in), quoteOut = gross − fee − tax.
///   snipe tax = 9900 >> ((elapsed·14)/3) unless exempt or overridden.
contract MockPonsCurve {
    error SlippageExceeded(uint256 actual, uint256 minimum);
    error ZeroAmount();

    event CurveBuy(address indexed buyer, address indexed recipient, uint256 quoteIn, uint256 tokensOut, uint256 fee, uint256 tax);
    event CurveSell(address indexed seller, address indexed recipient, uint256 tokensIn, uint256 quoteOut, uint256 fee, uint256 tax);
    event SnipeTaxCharged(address indexed recipient, uint256 amount);

    MockToken public token;
    uint256 public phantomQuote;
    uint256 public realQuoteReserve;
    uint256 public tokenReserve;
    uint256 public feeBps = 100;
    uint256 public creatorTaxBps;
    uint256 public launchedAt;
    uint256 public taxOverride = type(uint256).max; // max = use the time formula
    bool public eoaOnly;
    mapping(address => bool) public snipeTaxExempt;

    constructor(uint256 phantom, uint256 supply, uint256 creatorTax, uint256 launchedAt_) {
        token = new MockToken(address(this), supply);
        tokenReserve = supply;
        phantomQuote = phantom;
        creatorTaxBps = creatorTax;
        launchedAt = launchedAt_;
    }

    function setTaxOverride(uint256 v) external { taxOverride = v; }
    function setExempt(address a, bool e) external { snipeTaxExempt[a] = e; }
    function setEoaOnly(bool v) external { eoaOnly = v; }

    function quoteReserve() public view returns (uint256) { return phantomQuote + realQuoteReserve; }

    function getReserves() external view returns (uint256, uint256) { return (quoteReserve(), tokenReserve); }

    function currentSnipeTaxBps(address a) public view returns (uint256) {
        if (snipeTaxExempt[a]) return 0;
        if (taxOverride != type(uint256).max) return taxOverride;
        uint256 elapsed = block.timestamp - launchedAt;
        uint256 shift = (elapsed * 14) / 3;
        return shift >= 255 ? 0 : 9900 >> shift;
    }

    function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) external payable returns (uint256 tokensOut) {
        if (quoteIn == 0) revert ZeroAmount();
        require(msg.value == quoteIn, "value");
        if (eoaOnly) require(msg.sender == tx.origin, "eoa only");
        uint256 snipeTax = (quoteIn * currentSnipeTaxBps(msg.sender)) / 10_000;
        uint256 fee = (quoteIn * feeBps) / 10_000 + snipeTax;
        uint256 tax = (quoteIn * creatorTaxBps) / 10_000;
        uint256 net = quoteIn - fee - tax;
        tokensOut = (tokenReserve * net) / (quoteReserve() + net);
        if (tokensOut < minTokensOut) revert SlippageExceeded(tokensOut, minTokensOut);
        realQuoteReserve += net;
        tokenReserve -= tokensOut;
        token.transfer(recipient, tokensOut);
        if (snipeTax > 0) emit SnipeTaxCharged(recipient, snipeTax);
        emit CurveBuy(msg.sender, recipient, quoteIn, tokensOut, fee, tax);
    }

    function sell(uint256 tokensIn, uint256 minQuoteOut, address recipient) external returns (uint256 quoteOut) {
        if (tokensIn == 0) revert ZeroAmount();
        token.transferFrom(msg.sender, address(this), tokensIn);
        uint256 gross = (quoteReserve() * tokensIn) / (tokenReserve + tokensIn);
        uint256 fee = (gross * feeBps) / 10_000;
        uint256 tax = (gross * creatorTaxBps) / 10_000;
        quoteOut = gross - fee - tax;
        if (quoteOut < minQuoteOut) revert SlippageExceeded(quoteOut, minQuoteOut);
        realQuoteReserve -= gross;
        tokenReserve += tokensIn;
        (bool ok,) = recipient.call{value: quoteOut}("");
        require(ok, "eth");
        emit CurveSell(msg.sender, recipient, tokensIn, quoteOut, fee, tax);
    }

    receive() external payable {}
}

/// @notice Factory stand-in: getLaunchedToken(token) → LaunchInfo{token, curve, …} (15 static words).
contract MockPonsFactory {
    struct LaunchInfo {
        address token;
        address curve;
        address deployer;
        address creatorFeeRecipient;
        uint256 launchConfigId;
        uint256 graduationThreshold;
        uint256 creatorTaxBps;
        uint256 f7;
        uint256 f8;
        uint256 f9;
        uint256 f10;
        uint256 f11;
        uint256 f12;
        uint256 f13;
        bool f14;
    }

    mapping(address => address) public curveOf;

    function register(address token, address curve) external {
        curveOf[token] = curve;
    }

    function getLaunchedToken(address token) external view returns (LaunchInfo memory info) {
        address c = curveOf[token];
        if (c != address(0)) {
            info.token = token;
            info.curve = c;
            info.graduationThreshold = 4.2 ether;
        }
    }
}

/// @notice ArbSys stand-in placed at 0x64 in tests (L2 block number from storage slot 0).
contract MockArbSys {
    uint256 public n;

    function arbBlockNumber() external view returns (uint256) {
        return n;
    }
}
