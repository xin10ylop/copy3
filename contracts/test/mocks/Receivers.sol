// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Treasury that refuses ETH (L7: exits must not revert because of the receiver).
contract Rejecter {
    receive() external payable {
        revert("no ETH");
    }
}

/// @notice Treasury that burns all gas it is given (L7: a griefing receiver cannot brick exits).
contract GasBurner {
    uint256 public sink;

    receive() external payable {
        while (true) sink++;
    }
}
