// Usage: AMOUNT=0.02 npx hardhat run scripts/deposit.js --network mezotestnet
const hre = require("hardhat");
const deployment = require("../deployments/mezotestnet.json");

async function main() {
  const [signer] = await hre.ethers.getSigners();
  const vault = await hre.ethers.getContractAt("KeelVault", deployment.KeelVault, signer);
  const value = hre.ethers.parseEther(process.env.AMOUNT || "0.01");
  const receipt = await (await vault.deposit(signer.address, { value })).wait();
  console.log(`Deposited ${hre.ethers.formatEther(value)} BTC in tx ${receipt.hash}`);
  console.log(`Vault holds ${hre.ethers.formatEther(await vault.totalAssets())} BTC`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
