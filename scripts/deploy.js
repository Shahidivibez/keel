// Deploys KeelVault to Mezo testnet and records the address.
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const A = require("./addresses");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log(`Deployer ${deployer.address}, balance ${hre.ethers.formatEther(balance)} BTC`);

  const args = [A.BTC, A.MUSD, A.Router, A.PoolFactory, A.TroveManager, A.PriceFeed, A.HintHelpers, A.SortedTroves, A.keeperBps];
  const vault = await (await hre.ethers.getContractFactory("KeelVault")).deploy(...args);
  const receipt = await vault.deploymentTransaction().wait();
  const address = await vault.getAddress();
  console.log(`KeelVault deployed at ${address} (tx ${receipt.hash})`);

  const out = {
    chainId: A.chainId,
    KeelVault: address,
    deployTx: receipt.hash,
    deployBlock: receipt.blockNumber,
    deployer: deployer.address,
    constructorArgs: args,
  };
  const dir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "mezotestnet.json"), JSON.stringify(out, null, 2) + "\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
