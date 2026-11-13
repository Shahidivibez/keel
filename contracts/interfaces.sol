// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @dev Mezo Pools basic router (Aerodrome-style routes).
interface IMezoRouter {
    struct Route {
        address from;
        address to;
        bool stable;
        address factory;
    }

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        Route[] calldata routes,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);

    function getAmountsOut(
        uint256 amountIn,
        Route[] calldata routes
    ) external view returns (uint256[] memory amounts);
}

/// @dev MUSD TroveManager, redemption entry point only.
interface ITroveManager {
    function redeemCollateral(
        uint256 _amount,
        address _firstRedemptionHint,
        address _upperPartialRedemptionHint,
        address _lowerPartialRedemptionHint,
        uint256 _partialRedemptionHintNICR,
        uint256 _maxIterations
    ) external;
}

/// @dev MUSD PriceFeed: BTC/USD with 18 decimals.
interface IPriceFeed {
    function fetchPrice() external view returns (uint256);
}

/// @dev MUSD HintHelpers: finds where a redemption of a given size starts and ends.
interface IHintHelpers {
    function getRedemptionHints(
        uint256 _amount,
        uint256 _price,
        uint256 _maxIterations
    )
        external
        view
        returns (address firstRedemptionHint, uint256 partialRedemptionHintNICR, uint256 truncatedAmount);
}

/// @dev MUSD SortedTroves: troves ordered by collateral ratio.
interface ISortedTroves {
    function findInsertPosition(
        uint256 _NICR,
        address _prevId,
        address _nextId
    ) external view returns (address, address);
}
