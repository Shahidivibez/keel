const { expect } = require("chai");
const { ethers } = require("hardhat");

const E = ethers.parseEther;
const ORACLE = E("70000"); // BTC/USD
const POOL = E("77000"); // MUSD per BTC on the pool: MUSD trades about 9% below $1
const FAR = 2n ** 40n;

describe("KeelVault", () => {
  let vault, musd, btc, feed, router, tm, hints, alice, bob, keeper;

  beforeEach(async () => {
    [, alice, bob, keeper] = await ethers.getSigners();
    musd = await (await ethers.getContractFactory("MockMUSD")).deploy();
    btc = await (await ethers.getContractFactory("MockBtcToken")).deploy();
    feed = await (await ethers.getContractFactory("MockPriceFeed")).deploy(ORACLE);
    router = await (await ethers.getContractFactory("MockRouter")).deploy(btc, musd, POOL);
    tm = await (await ethers.getContractFactory("MockTroveManager")).deploy(btc, musd, feed, { value: E("50") });
    hints = await (await ethers.getContractFactory("MockHints")).deploy();
    vault = await (
      await ethers.getContractFactory("KeelVault")
    ).deploy(btc, musd, router, router, tm, feed, hints, hints, 1000);
  });

  const rebalance = (signer, btcIn, minProfit = 0) =>
    vault.connect(signer).rebalance(btcIn, minProfit, FAR);

  describe("deployment", () => {
    it("rejects a keeper cut above the cap and zero addresses", async () => {
      const F = await ethers.getContractFactory("KeelVault");
      await expect(F.deploy(btc, musd, router, router, tm, feed, hints, hints, 2001)).to.be.revertedWithCustomError(
        vault,
        "KeeperCutTooHigh"
      );
      await expect(
        F.deploy(btc, musd, router, router, ethers.ZeroAddress, feed, hints, hints, 1000)
      ).to.be.revertedWithCustomError(vault, "ZeroAddress");
    });
  });

  describe("deposit and redeem", () => {
    it("mints shares for BTC and returns the BTC on redeem", async () => {
      await expect(vault.connect(alice).deposit(alice, { value: E("1") }))
        .to.emit(vault, "Deposit")
        .withArgs(alice.address, alice.address, E("1"), E("1") * 1000n);
      expect(await vault.totalAssets()).to.equal(E("1"));

      const shares = await vault.balanceOf(alice);
      expect(await vault.convertToAssets(shares)).to.be.closeTo(E("1"), 1000n);
      await expect(vault.connect(alice).redeem(shares, alice)).to.changeEtherBalance(alice, E("1"));
      expect(await vault.totalSupply()).to.equal(0);
    });

    it("gives a second depositor the same share price", async () => {
      await vault.connect(alice).deposit(alice, { value: E("1") });
      await vault.connect(bob).deposit(bob, { value: E("3") });
      expect(await vault.balanceOf(bob)).to.be.closeTo((await vault.balanceOf(alice)) * 3n, 3000n);
    });

    it("can deposit for and redeem to another address", async () => {
      await vault.connect(alice).deposit(bob, { value: E("1") });
      expect(await vault.balanceOf(alice)).to.equal(0);
      const shares = await vault.balanceOf(bob);
      await expect(vault.connect(bob).redeem(shares, alice)).to.changeEtherBalance(alice, E("1"));
    });

    it("rejects zero amounts, zero receivers and redeeming more than owned", async () => {
      await expect(vault.connect(alice).deposit(alice)).to.be.revertedWithCustomError(vault, "ZeroAmount");
      await expect(
        vault.connect(alice).deposit(ethers.ZeroAddress, { value: 1 })
      ).to.be.revertedWithCustomError(vault, "ZeroAddress");
      await vault.connect(alice).deposit(alice, { value: E("1") });
      await expect(vault.connect(alice).redeem(0, alice)).to.be.revertedWithCustomError(vault, "ZeroAmount");
      await expect(vault.connect(bob).redeem(1000, bob)).to.be.revertedWithCustomError(
        vault,
        "ERC20InsufficientBalance"
      );
    });

    it("limits what a donation attack on the first deposit can take", async () => {
      // Attacker deposits dust, donates 1 BTC to inflate the share price, then the victim deposits.
      await vault.connect(bob).deposit(bob, { value: 1 });
      await bob.sendTransaction({ to: vault, value: E("1") });
      await vault.connect(alice).deposit(alice, { value: E("0.5") });
      const aliceValue = await vault.convertToAssets(await vault.balanceOf(alice));
      // The victim keeps more than 99.9% of the deposit...
      expect(aliceValue).to.be.gt(E("0.4995"));
      // ...and the attacker is left with about half of the 1 BTC donated, a net loss.
      const bobValue = await vault.convertToAssets(await vault.balanceOf(bob));
      expect(bobValue).to.be.lt(E("0.51"));
    });
  });

  describe("rebalance", () => {
    beforeEach(async () => {
      await vault.connect(alice).deposit(alice, { value: E("2") });
    });

    it("keeps the profit, pays the keeper and raises the share price", async () => {
      // 1 BTC -> 77,000 MUSD -> 1.1 BTC at the oracle price, minus the 0.75% fee.
      const profit = E("1.1") - (E("1.1") * 75n) / 10000n - E("1");
      const bounty = profit / 10n;
      const before = await vault.convertToAssets(E("1000"));

      const tx = rebalance(keeper, E("1"));
      await expect(tx).to.emit(vault, "Rebalance").withArgs(keeper.address, E("1"), E("77000"), E("77000"), profit, bounty);
      await expect(tx).to.changeEtherBalances([vault, keeper], [profit - bounty, bounty], { includeFee: false });

      expect(await vault.totalAssets()).to.equal(E("2") + profit - bounty);
      expect(await vault.totalProfit()).to.equal(profit - bounty);
      expect(await vault.totalBounties()).to.equal(bounty);
      expect(await vault.rebalanceCount()).to.equal(1);
      expect(await musd.balanceOf(vault)).to.equal(0);
      expect(await vault.convertToAssets(E("1000"))).to.be.gt(before);
    });

    it("lets existing holders keep the profit when a new depositor joins", async () => {
      await rebalance(keeper, E("1"));
      const aliceBefore = await vault.convertToAssets(await vault.balanceOf(alice));
      await vault.connect(bob).deposit(bob, { value: E("5") });
      expect(await vault.convertToAssets(await vault.balanceOf(alice))).to.be.closeTo(aliceBefore, 10n);
      expect(await vault.convertToAssets(await vault.balanceOf(bob))).to.be.closeTo(E("5"), 10n);
      const shares = await vault.balanceOf(alice);
      await expect(vault.connect(alice).redeem(shares, alice)).to.changeEtherBalance(alice, aliceBefore);
    });

    it("reverts when MUSD is at or above its peg", async () => {
      await router.setPoolPrice(E("69000")); // MUSD above $1: swap returns less than the oracle value
      await expect(rebalance(keeper, E("1"))).to.be.revertedWith("insufficient output");
      await router.setPoolPrice(ORACLE); // exactly at peg
      await expect(rebalance(keeper, E("1"))).to.be.revertedWithCustomError(vault, "NotBelowPeg");
    });

    it("reverts when the redemption fee eats the discount", async () => {
      await router.setPoolPrice(E("87500")); // 1.25x the oracle price
      await tm.setFeeBps(2000); // 1.25 * 0.8 = exactly break-even
      await expect(rebalance(keeper, E("1"))).to.be.revertedWithCustomError(vault, "NoProfit");
      expect(await vault.totalAssets()).to.equal(E("2"));
    });

    it("reverts below the caller's minimum profit", async () => {
      await expect(rebalance(keeper, E("1"), E("0.2"))).to.be.revertedWithCustomError(vault, "ProfitBelowMinimum");
      await expect(rebalance(keeper, E("1"), E("0.09"))).to.emit(vault, "Rebalance");
    });

    it("reverts for a zero trade, a trade larger than the vault, or an expired deadline", async () => {
      await expect(rebalance(keeper, 0)).to.be.revertedWithCustomError(vault, "ZeroAmount");
      await expect(rebalance(keeper, E("2") + 1n)).to.be.revertedWithCustomError(vault, "TradeTooLarge");
      await expect(vault.connect(keeper).rebalance(E("1"), 0, 1)).to.be.revertedWith("expired");
    });

    it("redeems MUSD left over from a partial fill on the next rebalance", async () => {
      // Deep discount so that a redemption filled only halfway is still profitable.
      await router.setPoolPrice(E("175000")); // 2.5x
      await hints.setMaxRedeemable(E("8750"));
      await expect(rebalance(keeper, E("0.1")))
        .to.emit(vault, "Rebalance")
        .withArgs(keeper.address, E("0.1"), E("17500"), E("8750"), anyUint, anyUint);
      expect(await musd.balanceOf(vault)).to.equal(E("8750"));

      await hints.setMaxRedeemable(ethers.MaxUint256);
      await expect(rebalance(keeper, E("0.1")))
        .to.emit(vault, "Rebalance")
        .withArgs(keeper.address, E("0.1"), E("17500"), E("26250"), anyUint, anyUint);
      expect(await musd.balanceOf(vault)).to.equal(0);
    });

    it("blocks re-entry from the keeper bounty payment", async () => {
      const k = await (await ethers.getContractFactory("ReentrantKeeper")).deploy();
      const call = vault.interface.encodeFunctionData("rebalance", [E("1"), 0, FAR]);
      for (const payload of [
        vault.interface.encodeFunctionData("deposit", [alice.address]),
        vault.interface.encodeFunctionData("redeem", [1, alice.address]),
        call,
      ]) {
        await k.arm(vault, payload);
        await expect(k.run(call)).to.be.revertedWithCustomError(vault, "TransferFailed");
      }
      expect(await vault.totalAssets()).to.equal(E("2"));
      expect(await vault.rebalanceCount()).to.equal(0);
    });
  });
});

function anyUint(v) {
  return typeof v === "bigint";
}
