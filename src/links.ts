import type { ExecutionStatus } from "./types.js";

export type ExplorerLink = {
  label: string;
  url: string;
};

export function nearTxUrl(hash: string, network: "mainnet" | "testnet"): string {
  const host = network === "mainnet" ? "https://nearblocks.io" : "https://testnet.nearblocks.io";
  return `${host}/txns/${hash}`;
}

export function nearAccountUrl(account: string, network: "mainnet" | "testnet"): string {
  const host = network === "mainnet" ? "https://nearblocks.io" : "https://testnet.nearblocks.io";
  return `${host}/address/${account}`;
}

export function baseTxUrl(hash: string): string {
  return `https://basescan.org/tx/${hash}`;
}

export function statusExplorerLinks(status: ExecutionStatus): ExplorerLink[] {
  const links: ExplorerLink[] = [];
  for (const hash of status.swapDetails?.nearTxHashes ?? []) {
    links.push({ label: `NEAR ${hash.slice(0, 10)}`, url: nearTxUrl(hash, "mainnet") });
  }
  for (const tx of status.swapDetails?.originChainTxHashes ?? []) {
    if (!tx.explorerUrl) continue;
    links.push({ label: `origin ${tx.hash.slice(0, 10)}`, url: tx.explorerUrl });
  }
  for (const tx of status.swapDetails?.destinationChainTxHashes ?? []) {
    if (!tx.explorerUrl) continue;
    links.push({ label: `destination ${tx.hash.slice(0, 10)}`, url: tx.explorerUrl });
  }
  return links;
}
