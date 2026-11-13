// Keeper: runs one rebalance on the deployed vault if it is profitable.
// Usage: BTC_IN=0.001 npx hardhat run scripts/rebalance.js --network mezotestnet
const hre = require("hardhat");
const deployment = require("../deployments/mezotestnet.json");

async function main() {
  const [keeper] = await hre.ethers.getSigners();
  const vault = await hre.ethers.getContractAt("KeelVault", deployment.KeelVault, keeper);
  const requested = hre.ethers.parseEther(process.env.BTC_IN || "0.001");
  const deadline = Math.floor(Date.now() / 1000) + 600;

  // Mezo refuses a redemption that would leave the loan at the front of the
  // queue below its minimum size. When that happens a larger trade, one that
  // repays that loan in full, goes through. Try the requested size first, then
  // double it up to the whole vault.
  const held = await vault.totalAssets();
  let btcIn = requested > held ? held : requested;
  let profit, bounty;
  for (;;) {
    try {
      [profit, bounty] = await vault.rebalance.staticCall(btcIn, 0, deadline);
      break;
    } catch (e) {
      const reason = e.reason || e.shortMessage || e.message;
      if (!/Unable to redeem|greater than zero/i.test(reason) || btcIn === held) {
        console.log(`Not profitable right now (${reason}). Nothing sent.`);
        return;
      }
      btcIn = btcIn * 2n > held ? held : btcIn * 2n;
    }
  }
  console.log(`Trading ${hre.ethers.formatEther(btcIn)} BTC`);
  console.log(`Expected profit ${hre.ethers.formatEther(profit)} BTC, bounty ${hre.ethers.formatEther(bounty)} BTC`);

  // Allow 2% slippage against the simulated profit.
  // Gas use varies a lot with how far the redeemed trove moves in the sorted
  // list, so leave headroom over the estimate, below the 10M block limit.
  const minProfit = (profit * 98n) / 100n;
  const gas = await vault.rebalance.estimateGas(btcIn, minProfit, deadline);
  const tx = await vault.rebalance(btcIn, minProfit, deadline, { gasLimit: gas * 2n > 9_500_000n ? 9_500_000n : gas * 2n });
  const receipt = await tx.wait();
  console.log(`Rebalanced in tx ${receipt.hash}`);
  console.log(`Vault holds ${hre.ethers.formatEther(await vault.totalAssets())} BTC`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
