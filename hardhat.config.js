require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

const accounts = process.env.DEPLOYER_KEY ? [process.env.DEPLOYER_KEY] : [];

module.exports = {
  solidity: {
    version: "0.8.28",
    settings: { evmVersion: "london", optimizer: { enabled: true, runs: 200 } },
  },
  etherscan: {
    apiKey: { mezotestnet: "empty" },
    customChains: [
      {
        network: "mezotestnet",
        chainId: 31611,
        urls: {
          apiURL: "https://api.explorer.test.mezo.org/api",
          browserURL: "https://explorer.test.mezo.org",
        },
      },
    ],
  },
  sourcify: { enabled: false },
  networks: {
    mezotestnet: { url: "https://rpc.test.mezo.org", chainId: 31611, accounts },
  },
};
