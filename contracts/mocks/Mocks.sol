// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IMezoRouter} from "../interfaces.sol";

// Test doubles for the Mezo contracts KeelVault talks to.
//
// On Mezo, BTC is the native asset and also an ERC-20 precompile whose
// balances mirror native balances, so the router can pull native BTC with
// transferFrom. A local EVM has no such precompile. These mocks get the same
// end-of-transaction balances another way: MockBtcToken records what the
// router "pulled" as a debt, and MockTroveManager nets that debt off the BTC
// it pays out. scripts/simulate.js runs the real contracts on live testnet state.

contract MockMUSD is ERC20 {
    constructor() ERC20("Mezo USD", "MUSD") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external {
        _burn(from, amount);
    }
}

contract MockBtcToken {
    mapping(address => uint256) public owed;
    mapping(address => mapping(address => uint256)) public allowance;

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transferFrom(address from, address, uint256 amount) external returns (bool) {
        require(allowance[from][msg.sender] >= amount, "allowance");
        require(from.balance >= owed[from] + amount, "balance");
        allowance[from][msg.sender] -= amount;
        owed[from] += amount;
        return true;
    }

    function settle(address account) external returns (uint256 amount) {
        amount = owed[account];
        owed[account] = 0;
    }
}

contract MockPriceFeed {
    uint256 public price;

    constructor(uint256 price_) {
        price = price_;
    }

    function setPrice(uint256 price_) external {
        price = price_;
    }

    function fetchPrice() external view returns (uint256) {
        return price;
    }
}

/// @dev Sells MUSD for BTC at a fixed pool price (MUSD per BTC, 18 decimals).
contract MockRouter {
    MockBtcToken public immutable btc;
    MockMUSD public immutable musd;
    uint256 public poolPrice;

    constructor(MockBtcToken btc_, MockMUSD musd_, uint256 poolPrice_) {
        btc = btc_;
        musd = musd_;
        poolPrice = poolPrice_;
    }

    function setPoolPrice(uint256 poolPrice_) external {
        poolPrice = poolPrice_;
    }

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        IMezoRouter.Route[] calldata,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts) {
        require(block.timestamp <= deadline, "expired");
        uint256 out = (amountIn * poolPrice) / 1e18;
        require(out >= amountOutMin, "insufficient output");
        btc.transferFrom(msg.sender, address(this), amountIn);
        musd.mint(to, out);
        amounts = new uint256[](2);
        amounts[0] = amountIn;
        amounts[1] = out;
    }
}

/// @dev Redeems MUSD for BTC at the oracle price minus a fee.
contract MockTroveManager {
    MockBtcToken public immutable btc;
    MockMUSD public immutable musd;
    MockPriceFeed public immutable feed;
    uint256 public feeBps = 75;

    constructor(MockBtcToken btc_, MockMUSD musd_, MockPriceFeed feed_) payable {
        btc = btc_;
        musd = musd_;
        feed = feed_;
    }

    receive() external payable {}

    function setFeeBps(uint256 feeBps_) external {
        feeBps = feeBps_;
    }

    function redeemCollateral(uint256 redeemed, address first, address, address, uint256, uint256) external {
        require(first == address(0xF1), "mock: bad hint");
        musd.burn(msg.sender, redeemed);
        uint256 gross = (redeemed * 1e18) / feed.price();
        uint256 payout = (gross * (10_000 - feeBps)) / 10_000;
        uint256 pulled = btc.settle(msg.sender);
        // A local EVM cannot take native BTC back from the redeemer, so a net
        // loss cannot be represented. Break-even (payout == pulled) can, and
        // that is what the NoProfit test uses.
        require(payout >= pulled, "mock: net loss");
        (bool ok, ) = msg.sender.call{value: payout - pulled}("");
        require(ok, "send");
    }
}

/// @dev Returns the hints it is given and passes the amount through, capped
/// by `maxRedeemable` to mimic a redemption that cannot be filled in full.
contract MockHints {
    uint256 public maxRedeemable = type(uint256).max;

    function setMaxRedeemable(uint256 maxRedeemable_) external {
        maxRedeemable = maxRedeemable_;
    }

    function getRedemptionHints(uint256 amount, uint256, uint256) external view returns (address, uint256, uint256) {
        return (address(0xF1), 1e18, amount < maxRedeemable ? amount : maxRedeemable);
    }

    function findInsertPosition(uint256, address prev, address next) external pure returns (address, address) {
        return (prev, next);
    }
}

/// @dev Keeper that tries to re-enter the vault when it receives its bounty.
contract ReentrantKeeper {
    address public vault;
    bytes public payload;

    function arm(address vault_, bytes calldata payload_) external {
        vault = vault_;
        payload = payload_;
    }

    function run(bytes calldata data) external {
        (bool ok, bytes memory ret) = vault.call(data);
        if (!ok) {
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
    }

    receive() external payable {
        (bool ok, bytes memory ret) = vault.call(payload);
        if (!ok) {
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
    }
}
