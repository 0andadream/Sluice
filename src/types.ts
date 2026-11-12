export const CHAINS = ["base", "near", "solana"] as const;
export type ChainId = (typeof CHAINS)[number];

export const CLICK_BLOCKCHAIN: Record<ChainId, "base" | "near" | "sol"> = {
  base: "base",
  near: "near",
  solana: "sol",
};

export const LLAMA_CHAIN: Record<ChainId, string> = {
  base: "Base",
  near: "Near",
  solana: "Solana",
};

export type VenueRef = {
  chain: ChainId;
  project: string;
};

export type Policy = {
  maxMoveUsd: number;
  allowedAssets: string[];
  allowedChains: ChainId[];
  venues: VenueRef[];
  minTvlUsd: number;
  minNetSpreadBps: number;
  slippageToleranceBps: number;
  quoteLossBufferBps: number;
  unauthenticatedFeeBps: number;
  stablecoinRouteFeeBps: number;
  assumedHoldDays: number;
  maxPaybackDays: number;
  cooldownSeconds: number;
  quoteDeadlineSeconds: number;
  capitalChain: ChainId;
  /** Addresses the model is allowed to name. Empty means the model may not name one. */
  allowedRecipients: string[];
};

export type Venue = {
  chain: ChainId;
  project: string;
  symbol: string;
  pool: string;
  tvlUsd: number;
  apy: number | null;
  apyBase: number | null;
  apyReward: number | null;
  poolMeta: string | null;
  decisionApy: number;
};

export type YieldBook = {
  source: "live" | "fixture";
  fetchedAt: string;
  url: string;
  candidates: Venue[];
  bestByChain: Partial<Record<ChainId, Venue>>;
};

export type Proposal = {
  fromChain: ChainId;
  toChain: ChainId;
  asset: string;
  amountUsd: number;
  fromProject: string;
  toProject: string;
  rationale: string;
};

export type BrainResult = {
  source: "rules" | "near-ai";
  proposal: Proposal;
  note: string;
  /** Set when the model output named a recipient. The gate treats that as a claim, not an instruction. */
  claimedRecipient: string | null;
  attestation: {
    /** This process does not verify TEE quotes or response signatures. */
    verified: false;
    detail: string;
  };
};

export type GateDecision = {
  approved: boolean;
  reasons: string[];
  grossSpreadBps: number | null;
  feeBps: number | null;
  oneTimeCostBps: number | null;
  annualizedCostBps: number | null;
  netSpreadBps: number | null;
  paybackDays: number | null;
};

export type Token = {
  assetId: string;
  decimals: number;
  blockchain: string;
  symbol: string;
  price: number;
  priceUpdatedAt: string;
  contractAddress?: string;
};

export type QuoteRequest = {
  dry: boolean;
  swapType: "EXACT_INPUT";
  slippageTolerance: number;
  originAsset: string;
  depositType: "ORIGIN_CHAIN";
  destinationAsset: string;
  amount: string;
  refundTo: string;
  refundType: "ORIGIN_CHAIN";
  recipient: string;
  recipientType: "DESTINATION_CHAIN";
  deadline: string;
  quoteWaitingTimeMs?: number;
};

export type AppFee = {
  recipient: string;
  fee: number;
};

export type Quote = {
  depositAddress?: string;
  depositMemo?: string;
  amountIn: string;
  amountInFormatted: string;
  amountInUsd: string;
  minAmountIn: string;
  amountOut: string;
  amountOutFormatted: string;
  amountOutUsd: string;
  minAmountOut: string;
  timeEstimate: number;
  deadline?: string;
  timeWhenInactive?: string;
  refundFee?: string;
  withdrawFee?: string;
};

export type QuoteResponse = {
  correlationId: string;
  timestamp: string;
  signature: string;
  quoteRequest: QuoteRequest & { appFees?: AppFee[] };
  quote: Quote;
};

export const SWAP_STATUSES = [
  "KNOWN_DEPOSIT_TX",
  "PENDING_DEPOSIT",
  "INCOMPLETE_DEPOSIT",
  "PROCESSING",
  "SUCCESS",
  "REFUNDED",
  "FAILED",
] as const;

export type SwapStatus = (typeof SWAP_STATUSES)[number];

export type ExecutionStatus = {
  correlationId?: string;
  status: SwapStatus;
  updatedAt?: string;
  swapDetails?: {
    refundedAmount?: string;
    refundedAmountFormatted?: string;
    refundedAmountUsd?: string;
    refundReason?: string;
    amountOut?: string;
    amountOutFormatted?: string;
    destinationChainTxHashes?: { hash: string; explorerUrl: string }[];
    originChainTxHashes?: { hash: string; explorerUrl: string }[];
    nearTxHashes?: string[];
  };
};
