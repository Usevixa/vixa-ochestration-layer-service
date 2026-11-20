/**
 * Readable names for the chain codes the deposit assets API returns
 * (GET /payment/crypto/deposits/assets → chains[].chain).
 *
 * Only the label changes: the raw code stays the dropdown id and is what
 * gets sent to deposit initiate. Unknown codes fall back to the raw code, so
 * a new chain from the API still shows up, just unlabelled.
 *
 * Lookup ignores case and any spaces, dashes or underscores, so "trc20",
 * "TRC-20" and "TRC_20" all match. Labels must stay ≤ 30 chars (WhatsApp
 * dropdown title limit).
 */
const NAMES = {
  // TRON
  TRX: "TRON (TRC20)",
  TRON: "TRON (TRC20)",
  TRC20: "TRON (TRC20)",

  // Ethereum
  ETH: "Ethereum (ERC20)",
  ERC20: "Ethereum (ERC20)",
  ETHEREUM: "Ethereum (ERC20)",

  // BNB Smart Chain
  BSC: "BNB Smart Chain (BEP20)",
  BEP20: "BNB Smart Chain (BEP20)",
  BNB: "BNB Smart Chain (BEP20)",
  BNBSMARTCHAIN: "BNB Smart Chain (BEP20)",

  // Solana
  SOL: "Solana (SPL)",
  SOLANA: "Solana (SPL)",
  SPL: "Solana (SPL)",

  // Polygon
  MATIC: "Polygon (POS)",
  POLYGON: "Polygon (POS)",
  POL: "Polygon (POS)",

  // Ethereum L2s
  ARBI: "Arbitrum One",
  ARB: "Arbitrum One",
  ARBITRUM: "Arbitrum One",
  ARBITRUMONE: "Arbitrum One",
  OP: "Optimism",
  OPTIMISM: "Optimism",
  BASE: "Base",
  ZKSYNC: "zkSync Era",
  LINEA: "Linea",
  MANTLE: "Mantle",

  // Avalanche
  AVAXC: "Avalanche C-Chain",
  CAVAX: "Avalanche C-Chain",
  AVAX: "Avalanche C-Chain",
  AVALANCHE: "Avalanche C-Chain",

  // Others
  BTC: "Bitcoin",
  BITCOIN: "Bitcoin",
  TON: "TON",
  LTC: "Litecoin",
  DOGE: "Dogecoin",
  XRP: "XRP Ledger",
  XLM: "Stellar",
  ADA: "Cardano",
  DOT: "Polkadot",
  NEAR: "NEAR",
  APT: "Aptos",
  APTOS: "Aptos",
  SUI: "Sui",
  CELO: "Celo",
  ALGO: "Algorand",
};

const normalize = (code) => String(code ?? "").toUpperCase().replace(/[\s_-]/g, "");

/** Readable name for a chain code, or the raw code when it isn't mapped. */
export function chainLabel(code) {
  const raw = String(code ?? "").trim();
  return NAMES[normalize(raw)] || raw;
}
