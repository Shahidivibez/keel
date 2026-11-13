// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IMezoRouter, ITroveManager, IPriceFeed, IHintHelpers, ISortedTroves} from "./interfaces.sol";

/// @title KeelVault
/// @notice A BTC vault that earns by pulling MUSD back to its $1 peg.
///
/// When MUSD trades below $1 on Mezo Pools, anyone can call `rebalance`:
/// the vault sells BTC for discounted MUSD on the pool, then redeems that
/// MUSD for $1 of BTC each through the MUSD TroveManager. The transaction
/// reverts unless the vault ends with more BTC than it started with.
/// Profit stays in the vault and raises the value of every share; the
/// caller receives a fixed cut as a keeper bounty.
///
/// There is no owner and no upgrade path. Every parameter is immutable.
contract KeelVault is ERC20, ReentrancyGuard {
    /// @dev Virtual shares/assets protect the first depositor from share
    /// price inflation by donation.
    uint256 private constant VIRTUAL_SHARES = 1e3;
    uint256 private constant VIRTUAL_ASSETS = 1;
    uint256 private constant BPS = 10_000;
    uint256 public constant MAX_KEEPER_BPS = 2_000;

    /// @notice ERC-20 facade of native BTC on Mezo. Its balances mirror
    /// native balances, so approving it lets the router pull native BTC.
    IERC20 public immutable btcToken;
    IERC20 public immutable musd;
    IMezoRouter public immutable router;
    address public immutable poolFactory;
    ITroveManager public immutable troveManager;
    IPriceFeed public immutable priceFeed;
    IHintHelpers public immutable hintHelpers;
    ISortedTroves public immutable sortedTroves;
    /// @notice Share of each rebalance profit paid to the caller.
    uint256 public immutable keeperBps;

    /// @notice Lifetime BTC profit kept by the vault, after bounties.
    uint256 public totalProfit;
    /// @notice Lifetime BTC paid to keepers.
    uint256 public totalBounties;
    /// @notice Number of successful rebalances.
    uint256 public rebalanceCount;

    event Deposit(address indexed sender, address indexed receiver, uint256 assets, uint256 shares);
    event Withdraw(address indexed owner, address indexed receiver, uint256 assets, uint256 shares);
    event Rebalance(
        address indexed keeper,
        uint256 btcIn,
        uint256 musdBought,
        uint256 musdRedeemed,
        uint256 profit,
        uint256 bounty
    );

    error ZeroAmount();
    error ZeroAddress();
    error KeeperCutTooHigh();
    error TradeTooLarge();
    error ApproveFailed();
    error NotBelowPeg(uint256 musdOut, uint256 oracleValue);
    error NoProfit(uint256 balanceBefore, uint256 balanceAfter);
    error ProfitBelowMinimum(uint256 profit, uint256 minProfit);
    error TransferFailed();

    constructor(
        address btcToken_,
        address musd_,
        address router_,
        address poolFactory_,
        address troveManager_,
        address priceFeed_,
        address hintHelpers_,
        address sortedTroves_,
        uint256 keeperBps_
    ) ERC20("Keel BTC", "kBTC") {
        if (
            btcToken_ == address(0) ||
            musd_ == address(0) ||
            router_ == address(0) ||
            poolFactory_ == address(0) ||
            troveManager_ == address(0) ||
            priceFeed_ == address(0) ||
            hintHelpers_ == address(0) ||
            sortedTroves_ == address(0)
        ) revert ZeroAddress();
        if (keeperBps_ > MAX_KEEPER_BPS) revert KeeperCutTooHigh();
        btcToken = IERC20(btcToken_);
        musd = IERC20(musd_);
        router = IMezoRouter(router_);
        poolFactory = poolFactory_;
        troveManager = ITroveManager(troveManager_);
        priceFeed = IPriceFeed(priceFeed_);
        hintHelpers = IHintHelpers(hintHelpers_);
        sortedTroves = ISortedTroves(sortedTroves_);
        keeperBps = keeperBps_;
    }

    /// @dev Accepts BTC from MUSD redemptions. Any other BTC sent here is a
    /// donation to share holders.
    receive() external payable {}

    // ------------------------------------------------------------------
    // Vault
    // ------------------------------------------------------------------

    /// @notice BTC held by the vault. MUSD left over from a partly filled
    /// redemption is not counted until it is redeemed.
    function totalAssets() public view returns (uint256) {
        return address(this).balance;
    }

    function convertToShares(uint256 assets) public view returns (uint256) {
        return _toShares(assets, totalAssets());
    }

    function convertToAssets(uint256 shares) public view returns (uint256) {
        return (shares * (totalAssets() + VIRTUAL_ASSETS)) / (totalSupply() + VIRTUAL_SHARES);
    }

    /// @notice Deposit native BTC and mint shares to `receiver`.
    function deposit(address receiver) external payable nonReentrant returns (uint256 shares) {
        if (msg.value == 0) revert ZeroAmount();
        if (receiver == address(0)) revert ZeroAddress();
        // msg.value is already in the balance; price shares on the amount before it.
        shares = _toShares(msg.value, address(this).balance - msg.value);
        if (shares == 0) revert ZeroAmount();
        _mint(receiver, shares);
        emit Deposit(msg.sender, receiver, msg.value, shares);
    }

    /// @notice Burn `shares` from the caller and send the BTC they are worth to `receiver`.
    function redeem(uint256 shares, address receiver) external nonReentrant returns (uint256 assets) {
        if (shares == 0) revert ZeroAmount();
        if (receiver == address(0)) revert ZeroAddress();
        assets = convertToAssets(shares);
        if (assets == 0) revert ZeroAmount();
        _burn(msg.sender, shares);
        _send(receiver, assets);
        emit Withdraw(msg.sender, receiver, assets, shares);
    }

    // ------------------------------------------------------------------
    // Peg rebalance
    // ------------------------------------------------------------------

    /// @notice Sell `btcIn` BTC for MUSD on Mezo Pools and redeem the MUSD
    /// for BTC through the MUSD TroveManager. Callable by anyone.
    /// @dev Reverts unless the vault's BTC balance increases.
    /// @param btcIn BTC to sell.
    /// @param minProfit Minimum BTC profit before the bounty, else revert.
    /// @param deadline Swap deadline (unix seconds).
    /// @return profit BTC profit before the bounty.
    /// @return bounty BTC paid to the caller.
    function rebalance(
        uint256 btcIn,
        uint256 minProfit,
        uint256 deadline
    ) external nonReentrant returns (uint256 profit, uint256 bounty) {
        if (btcIn == 0) revert ZeroAmount();
        uint256 balanceBefore = address(this).balance;
        if (btcIn > balanceBefore) revert TradeTooLarge();

        uint256 price = priceFeed.fetchPrice();
        uint256 musdBought = _buyMusd(btcIn, price, deadline);
        uint256 musdRedeemed = _redeemAll(price);

        // The vault must end with more BTC than it started with.
        uint256 balanceAfter = address(this).balance;
        if (balanceAfter <= balanceBefore) revert NoProfit(balanceBefore, balanceAfter);
        profit = balanceAfter - balanceBefore;
        if (profit < minProfit) revert ProfitBelowMinimum(profit, minProfit);

        bounty = (profit * keeperBps) / BPS;
        totalProfit += profit - bounty;
        totalBounties += bounty;
        rebalanceCount += 1;
        emit Rebalance(msg.sender, btcIn, musdBought, musdRedeemed, profit, bounty);
        if (bounty > 0) _send(msg.sender, bounty);
    }

    /// @dev Buys MUSD with BTC. The swap must return more MUSD than the
    /// oracle value of the BTC sold, otherwise MUSD is not below its peg
    /// and there is no discount to redeem.
    function _buyMusd(uint256 btcIn, uint256 price, uint256 deadline) private returns (uint256 musdBought) {
        uint256 oracleValue = (btcIn * price) / 1e18;
        if (!btcToken.approve(address(router), btcIn)) revert ApproveFailed();
        IMezoRouter.Route[] memory routes = new IMezoRouter.Route[](1);
        routes[0] = IMezoRouter.Route(address(btcToken), address(musd), false, poolFactory);
        uint256[] memory amounts = router.swapExactTokensForTokens(
            btcIn,
            oracleValue,
            routes,
            address(this),
            deadline
        );
        musdBought = amounts[amounts.length - 1];
        if (musdBought <= oracleValue) revert NotBelowPeg(musdBought, oracleValue);
    }

    /// @dev Redeems all MUSD the vault holds, including any left over from
    /// an earlier partial fill. BTC arrives through receive().
    ///
    /// Redemption hints depend on the oracle price, which changes every
    /// block on Mezo, so hints computed off chain are stale by the time a
    /// transaction lands. They are computed here, in the same transaction
    /// and at the same price the TroveManager will use.
    function _redeemAll(uint256 price) private returns (uint256 musdRedeemed) {
        uint256 musdBefore = musd.balanceOf(address(this));
        (address first, uint256 partialNICR, uint256 redeemable) = hintHelpers.getRedemptionHints(
            musdBefore,
            price,
            0
        );
        (address upper, address lower) = sortedTroves.findInsertPosition(partialNICR, first, first);
        troveManager.redeemCollateral(redeemable, first, upper, lower, partialNICR, 0);
        musdRedeemed = musdBefore - musd.balanceOf(address(this));
    }

    // ------------------------------------------------------------------
    // Internal
    // ------------------------------------------------------------------

    function _toShares(uint256 assets, uint256 assetsBefore) private view returns (uint256) {
        return (assets * (totalSupply() + VIRTUAL_SHARES)) / (assetsBefore + VIRTUAL_ASSETS);
    }

    function _send(address to, uint256 amount) private {
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}
