//! Policy gate for Sluice. The agent proposes a USDC move. This contract
//! approves or vetoes it. A function-call key scoped to `approve` cannot
//! change the policy and cannot attach a deposit.
use near_sdk::{env, near, AccountId, PanicOnDefault};

const HISTORY: usize = 16;
const SUMMARY_LEN: usize = 360;

#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct Venue {
    pub chain: String,
    pub project: String,
}

#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct Policy {
    pub max_move_usd_cents: u64,
    pub allowed_assets: Vec<String>,
    pub allowed_chains: Vec<String>,
    pub venues: Vec<Venue>,
    pub min_net_spread_bps: i64,
    pub slippage_tolerance_bps: u64,
    pub unauthenticated_fee_bps: u64,
    pub stablecoin_route_fee_bps: u64,
    pub assumed_hold_days: u64,
    pub max_payback_days: u64,
    pub cooldown_seconds: u64,
    pub has_one_click_key: bool,
    pub allowed_recipients: Vec<String>,
}

#[near(serializers = [json])]
#[derive(Clone)]
pub struct ProposalInput {
    pub from_chain: String,
    pub to_chain: String,
    pub asset: String,
    pub amount_usd_cents: u64,
    pub from_project: String,
    pub to_project: String,
    pub recipient: String,
    pub source_apy_ppm: i64,
    pub dest_apy_ppm: i64,
}

#[near(serializers = [json])]
#[derive(Clone)]
pub struct DecisionView {
    pub id: u64,
    pub approved: bool,
    pub reasons: Vec<String>,
    pub gross_spread_bps: i64,
    pub fee_bps: u64,
    pub one_time_cost_bps: u64,
    pub annualized_cost_bps: u64,
    pub net_spread_bps: i64,
    pub payback: String,
    pub recorded_at_ms: u64,
}

#[near(serializers = [json])]
#[derive(Clone)]
pub struct HistoryItem {
    pub id: u64,
    pub approved: bool,
    pub summary: String,
    pub recorded_at_ms: u64,
}

#[near(serializers = [json])]
#[derive(Clone)]
pub struct StateView {
    pub owner: AccountId,
    pub agent: AccountId,
    pub last_approved_ms: u64,
    pub decision_count: u64,
}

#[near(serializers = [borsh])]
#[derive(Clone, Copy)]
struct StoredDecision {
    id: u64,
    approved: bool,
    recorded_at_ms: u64,
    summary: [u8; SUMMARY_LEN],
}

impl StoredDecision {
    const fn empty() -> Self {
        Self {
            id: 0,
            approved: false,
            recorded_at_ms: 0,
            summary: [0; SUMMARY_LEN],
        }
    }

    fn to_item(self) -> HistoryItem {
        HistoryItem {
            id: self.id,
            approved: self.approved,
            summary: unpack(&self.summary),
            recorded_at_ms: self.recorded_at_ms,
        }
    }
}

fn pack(text: &str) -> [u8; SUMMARY_LEN] {
    let mut out = [0u8; SUMMARY_LEN];
    let bytes = text.as_bytes();
    let n = bytes.len().min(SUMMARY_LEN);
    out[..n].copy_from_slice(&bytes[..n]);
    out
}

fn unpack(bytes: &[u8]) -> String {
    let end = bytes.iter().position(|byte| *byte == 0).unwrap_or(bytes.len());
    String::from_utf8_lossy(&bytes[..end]).into_owned()
}

/// Math.round for an integer division. Halves go toward +infinity.
fn round_div_js(numer: i128, denom: i128) -> i128 {
    assert!(denom > 0, "denominator");
    if numer >= 0 {
        (numer + denom / 2) / denom
    } else {
        let q = numer.div_euclid(denom);
        let r = numer.rem_euclid(denom);
        if r * 2 >= denom { q + 1 } else { q }
    }
}

fn gross_spread_bps(dest_ppm: i64, source_ppm: i64) -> i64 {
    round_div_js(dest_ppm as i128 - source_ppm as i128, 10_000) as i64
}

fn fee_bps(policy: &Policy, proposal: &ProposalInput) -> u64 {
    let stable = proposal.asset == "USDC"
        && policy.allowed_assets.iter().any(|asset| asset == "USDC")
        && proposal.from_chain != proposal.to_chain;
    if policy.has_one_click_key && stable {
        policy.stablecoin_route_fee_bps
    } else {
        policy.unauthenticated_fee_bps
    }
}

fn check_policy(policy: &Policy) {
    assert!(policy.max_move_usd_cents > 0, "max_move_usd_cents must be positive");
    assert!(policy.assumed_hold_days > 0, "assumed_hold_days must be positive");
    assert!(!policy.allowed_assets.is_empty(), "allowed_assets is empty");
    assert!(!policy.allowed_chains.is_empty(), "allowed_chains is empty");
}

fn too_long(value: &str, max: usize) -> bool {
    value.len() > max
}

fn evaluate(policy: &Policy, proposal: &ProposalInput, last_approved_ms: u64, now_ms: u64) -> DecisionView {
    let mut reasons = Vec::new();
    if too_long(&proposal.asset, 16) {
        reasons.push("asset is too long".to_string());
    } else if !policy.allowed_assets.iter().any(|asset| asset == &proposal.asset) {
        reasons.push(format!("asset {} is not in allowedAssets", proposal.asset));
    }
    if too_long(&proposal.from_chain, 16) {
        reasons.push("from_chain is too long".to_string());
    } else if !policy.allowed_chains.iter().any(|chain| chain == &proposal.from_chain) {
        reasons.push(format!("fromChain {} is not allowed", proposal.from_chain));
    }
    if too_long(&proposal.to_chain, 16) {
        reasons.push("to_chain is too long".to_string());
    } else if !policy.allowed_chains.iter().any(|chain| chain == &proposal.to_chain) {
        reasons.push(format!("toChain {} is not allowed", proposal.to_chain));
    }
    if proposal.from_chain == proposal.to_chain {
        reasons.push("fromChain and toChain are the same".to_string());
    }
    if too_long(&proposal.from_project, 32) {
        reasons.push("from_project is too long".to_string());
    } else if !policy.venues.iter().any(|venue| venue.chain == proposal.from_chain && venue.project == proposal.from_project) {
        reasons.push(format!("fromProject {} is not an allowed venue", proposal.from_project));
    }
    if too_long(&proposal.to_project, 32) {
        reasons.push("to_project is too long".to_string());
    } else if !policy.venues.iter().any(|venue| venue.chain == proposal.to_chain && venue.project == proposal.to_project) {
        reasons.push(format!("toProject {} is not an allowed venue", proposal.to_project));
    }
    if proposal.amount_usd_cents == 0 {
        reasons.push("amount_usd_cents must be positive".to_string());
    } else if proposal.amount_usd_cents > policy.max_move_usd_cents {
        reasons.push(format!(
            "amount_usd_cents {} exceeds max_move_usd_cents {}",
            proposal.amount_usd_cents, policy.max_move_usd_cents
        ));
    }
    if too_long(&proposal.recipient, 64) {
        reasons.push("recipient is too long".to_string());
    } else if !proposal.recipient.is_empty()
        && !policy.allowed_recipients.iter().any(|item| item == &proposal.recipient)
    {
        reasons.push(format!("recipient {} is not an allowed recipient", proposal.recipient));
    }
    if last_approved_ms > 0 && last_approved_ms > now_ms {
        reasons.push("last approval time is in the future".to_string());
    } else if last_approved_ms > 0 {
        let elapsed = now_ms as u128 - last_approved_ms as u128;
        let cooldown_ms = (policy.cooldown_seconds as u128).saturating_mul(1000);
        if elapsed < cooldown_ms {
            let wait = (cooldown_ms - elapsed).div_ceil(1000);
            reasons.push(format!("cooldown has {wait}s left"));
        }
    }

    let gross = gross_spread_bps(proposal.dest_apy_ppm, proposal.source_apy_ppm);
    let fee = fee_bps(policy, proposal);
    let one_time = fee + policy.slippage_tolerance_bps;
    let annualized = round_div_js(one_time as i128 * 365, policy.assumed_hold_days as i128) as u64;
    let net = gross - annualized as i64;
    if net < policy.min_net_spread_bps {
        reasons.push(format!(
            "net spread {net} bps is below minNetSpreadBps {} (gross {gross} bps, annualized cost {annualized} bps)",
            policy.min_net_spread_bps
        ));
    }
    let payback = if gross <= 0 {
        reasons.push("spread is not positive, so the fee and slippage are not earned back".to_string());
        "infinite".to_string()
    } else {
        let numer = one_time as u128 * 365 * 10;
        let tenths = (numer + (gross as u128) / 2) / (gross as u128);
        if one_time as u128 * 365 > policy.max_payback_days as u128 * gross as u128 {
            reasons.push(format!(
                "payback {}.{} days exceeds maxPaybackDays {}",
                tenths / 10,
                tenths % 10,
                policy.max_payback_days
            ));
        }
        format!("{}.{}", tenths / 10, tenths % 10)
    };

    DecisionView {
        id: 0,
        approved: reasons.is_empty(),
        reasons,
        gross_spread_bps: gross,
        fee_bps: fee,
        one_time_cost_bps: one_time,
        annualized_cost_bps: annualized,
        net_spread_bps: net,
        payback,
        recorded_at_ms: now_ms,
    }
}

fn emit(decision: &DecisionView) {
    let payload = near_sdk::serde_json::json!({
        "standard": "sluice",
        "version": "1.0.0",
        "event": "decision",
        "data": [{
            "id": decision.id,
            "approved": decision.approved,
            "reasons": decision.reasons,
            "gross_spread_bps": decision.gross_spread_bps,
            "net_spread_bps": decision.net_spread_bps,
            "recorded_at_ms": decision.recorded_at_ms,
        }]
    });
    env::log_str(&format!("EVENT_JSON:{payload}"));
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct SluiceGate {
    owner: AccountId,
    agent: AccountId,
    policy: Policy,
    last_approved_ms: u64,
    count: u64,
    next_id: u64,
    history: [StoredDecision; HISTORY],
}

#[near]
impl SluiceGate {
    #[init]
    #[payable]
    pub fn new(owner: AccountId, agent: AccountId, policy: Policy) -> Self {
        check_policy(&policy);
        Self {
            owner,
            agent,
            policy,
            last_approved_ms: 0,
            count: 0,
            next_id: 1,
            history: [StoredDecision::empty(); HISTORY],
        }
    }

    pub fn set_policy(&mut self, policy: Policy) {
        assert_eq!(env::predecessor_account_id(), self.owner, "only the owner can set policy");
        check_policy(&policy);
        self.policy = policy;
    }

    /// View. Same checks as `approve`, with no state change and no event.
    pub fn preview(&self, proposal: ProposalInput) -> DecisionView {
        evaluate(&self.policy, &proposal, self.last_approved_ms, env::block_timestamp() / 1_000_000)
    }

    pub fn approve(&mut self, proposal: ProposalInput) -> DecisionView {
        assert_eq!(env::predecessor_account_id(), self.agent, "only the agent account can approve");
        let mut decision = evaluate(
            &self.policy,
            &proposal,
            self.last_approved_ms,
            env::block_timestamp() / 1_000_000,
        );
        decision.id = self.next_id;
        self.next_id += 1;
        let index = (self.count % HISTORY as u64) as usize;
        let summary = if decision.approved {
            format!("approved net {} bps", decision.net_spread_bps)
        } else {
            decision.reasons.join("; ")
        };
        self.history[index] = StoredDecision {
            id: decision.id,
            approved: decision.approved,
            recorded_at_ms: decision.recorded_at_ms,
            summary: pack(&summary),
        };
        self.count += 1;
        if decision.approved {
            self.last_approved_ms = decision.recorded_at_ms;
        }
        emit(&decision);
        decision
    }

    pub fn get_policy(&self) -> Policy {
        self.policy.clone()
    }

    pub fn get_state(&self) -> StateView {
        StateView {
            owner: self.owner.clone(),
            agent: self.agent.clone(),
            last_approved_ms: self.last_approved_ms,
            decision_count: self.count,
        }
    }

    pub fn latest_decisions(&self, limit: u32) -> Vec<HistoryItem> {
        let filled = self.count.min(HISTORY as u64);
        let take = (limit as u64).min(filled) as usize;
        let mut out = Vec::with_capacity(take);
        for step in 0..take {
            let index = (self.count - 1 - step as u64) % HISTORY as u64;
            out.push(self.history[index as usize].to_item());
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{get_logs, VMContextBuilder};
    use near_sdk::testing_env;

    fn policy() -> Policy {
        Policy {
            max_move_usd_cents: 1000,
            allowed_assets: vec!["USDC".to_string()],
            allowed_chains: vec!["base".to_string(), "near".to_string(), "solana".to_string()],
            venues: vec![
                Venue { chain: "base".to_string(), project: "fluid-lending".to_string() },
                Venue { chain: "near".to_string(), project: "rhea-lend".to_string() },
                Venue { chain: "solana".to_string(), project: "save".to_string() },
            ],
            min_net_spread_bps: 50,
            slippage_tolerance_bps: 50,
            unauthenticated_fee_bps: 20,
            stablecoin_route_fee_bps: 1,
            assumed_hold_days: 365,
            max_payback_days: 180,
            cooldown_seconds: 3600,
            has_one_click_key: false,
            allowed_recipients: vec![],
        }
    }

    fn good() -> ProposalInput {
        ProposalInput {
            from_chain: "base".to_string(),
            to_chain: "near".to_string(),
            asset: "USDC".to_string(),
            amount_usd_cents: 1000,
            from_project: "fluid-lending".to_string(),
            to_project: "rhea-lend".to_string(),
            recipient: String::new(),
            source_apy_ppm: 5_230_000,
            dest_apy_ppm: 10_206_280,
        }
    }

    fn attack() -> ProposalInput {
        let mut proposal = good();
        proposal.amount_usd_cents = 500_000;
        proposal.recipient = "attacker.near".to_string();
        proposal
    }

    fn set(ms: u64, predecessor: &str) {
        let mut builder = VMContextBuilder::new();
        builder
            .current_account_id("gate.testnet".parse().unwrap())
            .predecessor_account_id(predecessor.parse().unwrap())
            .signer_account_id(predecessor.parse().unwrap())
            .block_timestamp(ms * 1_000_000);
        testing_env!(builder.build());
    }

    fn contract() -> SluiceGate {
        set(1_700_000_000_000, "agent.testnet");
        SluiceGate::new("owner.testnet".parse().unwrap(), "agent.testnet".parse().unwrap(), policy())
    }

    #[test]
    fn round_div_matches_javascript() {
        assert_eq!(round_div_js(4_976_280, 10_000), 498);
        assert_eq!(round_div_js(3, 2), 2);
        assert_eq!(round_div_js(-3, 2), -1);
        assert_eq!(gross_spread_bps(10_206_280, 5_230_000), 498);
    }

    #[test]
    fn approves_the_recorded_move_and_then_enforces_cooldown() {
        let mut gate = contract();
        set(1_700_000_000_000, "agent.testnet");
        let first = gate.approve(good());
        assert!(first.approved, "{:?}", first.reasons);
        assert_eq!(first.gross_spread_bps, 498);
        assert_eq!(first.fee_bps, 20);
        assert_eq!(first.net_spread_bps, 428);
        assert_eq!(first.payback, "51.3");
        set(1_700_000_001_000, "agent.testnet");
        let second = gate.approve(good());
        assert!(!second.approved);
        assert!(second.reasons.iter().any(|reason| reason.contains("cooldown")));
        set(1_700_000_000_000 + 3600 * 1000, "agent.testnet");
        let third = gate.approve(good());
        assert!(third.approved, "{:?}", third.reasons);
    }

    #[test]
    fn attack_blocks_injected_proposal() {
        let mut gate = contract();
        set(1_700_000_000_000, "agent.testnet");
        let decision = gate.approve(attack());
        assert!(!decision.approved);
        let reasons = decision.reasons.join(" | ");
        assert!(reasons.contains("amount_usd_cents 500000 exceeds max_move_usd_cents 1000"), "{reasons}");
        assert!(reasons.contains("recipient attacker.near is not an allowed recipient"), "{reasons}");
        assert_eq!(gate.get_state().last_approved_ms, 0);
        let logs = get_logs();
        assert!(logs.iter().any(|line| line.contains("EVENT_JSON") && line.contains("\"approved\":false")));
        println!("CONTRACT_VETO approved=false");
        println!("CONTRACT_REASONS {reasons}");

        let mut sized = good();
        sized.recipient = "attacker.near".to_string();
        let still = gate.preview(sized);
        assert!(!still.approved);
        assert!(still.reasons.iter().any(|reason| reason.contains("attacker.near")));
    }

    #[test]
    fn a_future_last_approval_blocks() {
        let mut gate = contract();
        set(1_700_000_060_000, "agent.testnet");
        let approved = gate.approve(good());
        assert!(approved.approved);
        set(1_700_000_000_000, "agent.testnet");
        let decision = gate.approve(good());
        assert!(!decision.approved);
        assert!(decision.reasons.iter().any(|reason| reason.contains("future")));
    }

    #[test]
    #[should_panic(expected = "only the owner can set policy")]
    fn agent_cannot_set_policy() {
        let mut gate = contract();
        set(1_700_000_000_000, "agent.testnet");
        gate.set_policy(policy());
    }

    #[test]
    #[should_panic(expected = "only the agent account can approve")]
    fn owner_cannot_approve_when_agent_is_separate() {
        let mut gate = contract();
        set(1_700_000_000_000, "owner.testnet");
        gate.approve(good());
    }

    #[test]
    fn history_is_a_fixed_ring() {
        let mut gate = contract();
        for n in 0..20 {
            set(1_700_000_000_000 + n, "agent.testnet");
            let _ = gate.approve(attack());
        }
        let latest = gate.latest_decisions(16);
        assert_eq!(latest.len(), 16);
        assert_eq!(latest[0].id, 20);
        assert!(!latest[0].approved);
        assert_eq!(gate.get_state().decision_count, 20);
    }
}
