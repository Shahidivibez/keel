// Dry run of KeelVault.rebalance against live Mezo testnet state.
// Nothing is sent and no key is needed: the vault bytecode and a BTC balance
// are injected with an eth_call state override.
const hre = require("hardhat");
const { ethers } = require("ethers");
const A = require("./addresses");

async function main() {
  // Deploy on the in-memory network only to get runtime code with immutables filled in.
  const F = await hre.ethers.getContractFactory("KeelVault");
  const local = await F.deploy(A.BTC, A.MUSD, A.Router, A.PoolFactory, A.TroveManager, A.PriceFeed, A.HintHelpers, A.SortedTroves, A.keeperBps);
  await local.waitForDeployment();
  const code = await hre.ethers.provider.getCode(await local.getAddress());

  const provider = new ethers.JsonRpcProvider(A.rpc);
  const vault = "0x00000000000000000000000000000000000CEE10";
  const keeper = "0x000000000000000000000000000000000000bEEF";
  const sizes = (process.env.SIZES || "0.001,0.01,0.1").split(",");

  for (const size of sizes) {
    const btcIn = ethers.parseEther(size);
    const data = F.interface.encodeFunctionData("rebalance", [btcIn, 0, Math.floor(Date.now() / 1000) + 600]);
    try {
      const raw = await provider.send("eth_call", [
        { from: keeper, to: vault, data },
        "latest",
        { [vault]: { code, balance: ethers.toQuantity(ethers.parseEther("1")) } },
      ]);
      const [profit, bounty] = F.interface.decodeFunctionResult("rebalance", raw);
      console.log(
        `${size} BTC -> profit ${ethers.formatEther(profit)} BTC (${(Number((profit * 100000n) / btcIn) / 1000).toFixed(2)}%)` +
          `, keeper bounty ${ethers.formatEther(bounty)} BTC`
      );
    } catch (e) {
      let reason = e.shortMessage || e.message;
      const d = e.data || e.info?.error?.data;
      if (d) {
        try {
          const err = F.interface.parseError(d);
          reason = err ? err.name : reason;
        } catch (_) {}
        if (d.startsWith("0x08c379a0")) {
          reason = ethers.AbiCoder.defaultAbiCoder().decode(["string"], "0x" + d.slice(10))[0];
        }
      }
      console.log(`${size} BTC -> reverted: ${reason}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
