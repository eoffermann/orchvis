import {
  DEFAULT_LIMITS,
  OWNER_ADDRESS,
  UiToBrokerFrameSchema,
  bumpEdge,
  createFrameFactory,
  decodeFrame,
  encodeFrame,
  mediaKindOf,
  repoNameFromKey,
  sessionAddress,
  threadIdFor,
  type Address,
  type BrokerToUiFrame,
  type ControlState,
  type EdgeStats,
  type MediaIndexEntry,
  type MediaRef,
  type Message,
  type MessageKind,
  type Platform,
  type SessionNode,
  type SessionStatus,
} from '@orchvis/protocol';
import type { Transport, TransportFactory } from '../net/transport';
import { fakeUlid, seededRandom } from './fakeFeed';

/**
 * The curated showcase scenario behind `?fake=showcase` (dev builds only):
 * a fixed cast of ~30 sessions in four repos on three hosts, a scripted
 * history with a story (a breaking payments API change rippling into web and
 * mobile, a CI outage, a latency investigation, Owner conversations), real
 * image, audio and video attachments served from bundled assets, and a
 * little live traffic so pulses are always in flight.
 *
 * Every name, host, repo, path and message here is invented. Every frame it
 * emits must pass `BrokerToUiFrameSchema` (see `test/showcase.test.ts`).
 */

const MINUTE = 60_000;

/** Showcase hosts: one per platform. */
const HOSTS = {
  win: { hostname: 'atlas-win', platform: 'win32' as Platform, home: 'C:/Users/jordan/src' },
  mac: { hostname: 'orion-mac', platform: 'darwin' as Platform, home: '/Users/maya/src' },
  linux: { hostname: 'forge-linux', platform: 'linux' as Platform, home: '/home/sam/src' },
} as const;
type HostKey = keyof typeof HOSTS;

/** Showcase repos by short key. */
const REPOS = {
  web: 'github.com/acme/storefront-web',
  pay: 'github.com/acme/payments-api',
  mobile: 'github.com/acme/mobile-app',
  infra: 'github.com/acme/platform-infra',
} as const;
type RepoKey = keyof typeof REPOS;

interface CastMember {
  name: string;
  host: HostKey;
  repos: RepoKey[];
  branch: string;
  status: SessionStatus;
  focus: string;
  poll?: boolean;
  offline?: boolean;
}

/** The cast: ~30 sessions with short stable names, as the SKILL asks. */
const CAST: readonly CastMember[] = [
  // storefront-web
  { name: 'WEB-CHECKOUT', host: 'win', repos: ['web'], branch: 'feat/checkout-v2', status: 'working', focus: 'Move checkout to payments API v2 intents (amount_minor)' },
  { name: 'WEB-CART', host: 'win', repos: ['web'], branch: 'perf/cart-drawer', status: 'working', focus: 'Cart drawer: virtualize line items, prices in minor units' },
  { name: 'WEB-SEARCH', host: 'mac', repos: ['web'], branch: 'feat/search-facets', status: 'idle', focus: 'Search facets and URL state' },
  { name: 'WEB-A11Y', host: 'mac', repos: ['web'], branch: 'fix/checkout-a11y', status: 'working', focus: 'Accessibility audit of the checkout forms', poll: true },
  { name: 'WEB-E2E', host: 'linux', repos: ['web'], branch: 'test/checkout-suite', status: 'working', focus: 'Playwright checkout suite on staging' },
  { name: 'WEB-I18N', host: 'win', repos: ['web'], branch: 'feat/de-ja-locales', status: 'idle', focus: 'de-DE and ja-JP translations, currency formats', poll: true },
  { name: 'WEB-PERF', host: 'mac', repos: ['web'], branch: 'perf/lcp-budget', status: 'working', focus: 'LCP budget: image CDN and font preload' },
  { name: 'DS-TOKENS', host: 'mac', repos: ['web', 'mobile'], branch: 'feat/tokens-v3', status: 'working', focus: 'Shared design tokens for web and mobile' },
  // payments-api
  { name: 'PAY-SCHEMA', host: 'linux', repos: ['pay'], branch: 'feat/intents-v2', status: 'working', focus: 'PaymentIntent v2: amount to amount_minor (breaking)' },
  { name: 'PAY-LEDGER', host: 'linux', repos: ['pay'], branch: 'fix/reconcile-locks', status: 'working', focus: 'Ledger reconcile job: lock waits under load' },
  { name: 'PAY-WEBHOOKS', host: 'linux', repos: ['pay'], branch: 'feat/webhook-retries', status: 'blocked', focus: 'Webhook retries and idempotency keys' },
  { name: 'PAY-FRAUD', host: 'win', repos: ['pay'], branch: 'feat/velocity-rules', status: 'idle', focus: 'Fraud rules engine: velocity checks' },
  { name: 'PAY-REFUNDS', host: 'win', repos: ['pay'], branch: 'feat/partial-refunds', status: 'working', focus: 'Partial refunds endpoint', poll: true },
  { name: 'PAY-DOCS', host: 'mac', repos: ['pay'], branch: 'docs/intents-v2', status: 'idle', focus: 'OpenAPI docs and SDK changelog for v2' },
  { name: 'PAY-LOADTEST', host: 'linux', repos: ['pay'], branch: 'perf/k6-2k-rps', status: 'working', focus: 'k6 load test at 2k rps against intents and ledger' },
  { name: 'API-SDK', host: 'linux', repos: ['pay', 'mobile'], branch: 'feat/sdk-2.0', status: 'working', focus: 'Generated Swift and Kotlin clients for API v2' },
  // mobile-app
  { name: 'IOS-CART', host: 'mac', repos: ['mobile'], branch: 'feat/cart-v2-intents', status: 'working', focus: 'iOS cart and Apple Pay sheet on v2 intents' },
  { name: 'ANDROID-CART', host: 'win', repos: ['mobile'], branch: 'feat/cart-v2-intents', status: 'working', focus: 'Android cart and Google Pay on v2 intents' },
  { name: 'MOBILE-RELEASE', host: 'mac', repos: ['mobile'], branch: 'release/4.12', status: 'blocked', focus: '4.12 release train' },
  { name: 'MOBILE-PUSH', host: 'linux', repos: ['mobile'], branch: 'feat/push-deeplinks', status: 'idle', focus: 'Push notification deep links' },
  { name: 'MOBILE-OFFLINE', host: 'mac', repos: ['mobile'], branch: 'feat/offline-cart', status: 'working', focus: 'Offline cart sync and conflict resolution', poll: true },
  { name: 'IOS-SNAPSHOT', host: 'mac', repos: ['mobile'], branch: 'test/dynamic-type', status: 'idle', focus: 'Snapshot tests for dynamic type sizes' },
  { name: 'MOBILE-CRASH', host: 'win', repos: ['mobile'], branch: 'main', status: 'idle', focus: "Crash triage from last night's TestFlight", offline: true },
  // platform-infra
  { name: 'INFRA-CI', host: 'linux', repos: ['infra'], branch: 'revert/pnpm-store-cache', status: 'working', focus: 'CI incident: ci-linux-xl runners OOM' },
  { name: 'INFRA-K8S', host: 'linux', repos: ['infra'], branch: 'chore/nodepool-1.33', status: 'working', focus: 'Staging node pool upgrade to 1.33' },
  { name: 'INFRA-OBS', host: 'linux', repos: ['infra'], branch: 'feat/payments-dash', status: 'working', focus: 'Dashboards and alert routing' },
  { name: 'INFRA-SECRETS', host: 'win', repos: ['infra'], branch: 'chore/rotate-staging-db', status: 'idle', focus: 'Rotate staging DB credentials', poll: true },
  { name: 'INFRA-CDN', host: 'mac', repos: ['infra'], branch: 'feat/image-cdn', status: 'working', focus: 'Image CDN rules for storefront' },
  { name: 'INFRA-DB', host: 'linux', repos: ['infra'], branch: 'plan/pg17', status: 'working', focus: 'Postgres 17 migration plan for payments' },
  { name: 'INFRA-COST', host: 'win', repos: ['infra'], branch: 'report/q4-cost', status: 'idle', focus: 'Cloud cost report for Q4' },
];

/** An attachment in the script: a bundled asset (or nothing, if expired). */
interface MediaSpec {
  /** File in `src/dev/showcase-media/`. Expired items may name a file that does not exist. */
  file: string;
  mime: string;
  /** Declared size of the original, as the sender's shim would report it. */
  bytes: number;
  caption: string;
  /** True for an item already gone from the store: it renders as a tombstone. */
  expired?: boolean;
}

/** One scripted message. `from`/`to` are cast names or `owner`. */
interface Line {
  /** Minutes before the scenario's start time. */
  ago: number;
  from: string;
  to: string;
  kind: MessageKind;
  body: string;
  media?: MediaSpec;
  /** Leave unread by the recipient. */
  unseen?: boolean;
}

const PNG = 'image/png';

/** The curated story, roughly in time order. */
const SCRIPT: readonly Line[] = [
  // --- The breaking change: payments-api v2 intents ripple into web and mobile.
  {
    ago: 52, from: 'PAY-SCHEMA', to: 'WEB-CHECKOUT', kind: 'notice',
    body: 'Heads-up: payments-api feat/intents-v2 replaces PaymentIntent.amount (number, major units) with amount_minor (integer, minor units) plus currency_exponent. Staging gets it at 14:00. v1 stays up at /v1/payment_intents until Friday.',
    media: { file: 'v1-intent-explorer.png', mime: PNG, bytes: 412_330, caption: 'API explorer screenshot of a v1 PaymentIntent response, showing amount: 128.4', expired: true },
  },
  {
    ago: 31, from: 'WEB-CHECKOUT', to: 'PAY-SCHEMA', kind: 'request',
    body: 'Is there a compatibility window? storefront-web main still reads intent.amount in src/checkout/OrderSummary.tsx and src/checkout/usePaymentIntent.ts. Could v2 return both fields until we ship?',
  },
  {
    ago: 29, from: 'PAY-SCHEMA', to: 'WEB-CHECKOUT', kind: 'response',
    body: 'No dual-write: amount was a float and caused the rounding bug in PAY-412. Switch to /v2 and compute amount_minor / 10^currency_exponent. Diff of the spec attached.',
    media: { file: 'intent-v2-diff.png', mime: PNG, bytes: 188_410, caption: 'Diff of openapi/payment_intent.yaml on feat/intents-v2: amount (number) removed, amount_minor (integer) and currency_exponent added' },
  },
  { ago: 41, from: 'owner', to: 'WEB-CHECKOUT', kind: 'request', body: 'Priority today: get checkout onto payments v2 before PAY-SCHEMA turns off v1 on Friday. Keep the old path behind the checkout_v2 flag until staging is clean.' },
  {
    ago: 40, from: 'WEB-CHECKOUT', to: 'owner', kind: 'response',
    body: "On it. Plan:\n1. usePaymentIntent calls /v2/payment_intents\n2. money formatting from amount_minor + currency_exponent\n3. contract test against payments-api's openapi/payment_intent.yaml\n4. checkout_v2 flag default off\nI'll report when staging is green.",
  },
  { ago: 30, from: 'PAY-SCHEMA', to: 'IOS-CART', kind: 'notice', body: 'Heads-up: /v2/payment_intents returns amount_minor (integer) and currency_exponent instead of amount. v1 is switched off on Friday.' },
  { ago: 29.5, from: 'PAY-SCHEMA', to: 'ANDROID-CART', kind: 'notice', body: 'Heads-up: /v2/payment_intents returns amount_minor (integer) and currency_exponent instead of amount. v1 is switched off on Friday.' },
  { ago: 25, from: 'API-SDK', to: 'PAY-SCHEMA', kind: 'request', body: 'Which commit of openapi/payment_intent.yaml is final for v2? I want to generate the 2.0 clients from a pinned spec.' },
  { ago: 24.5, from: 'PAY-SCHEMA', to: 'API-SDK', kind: 'response', body: 'a91f3c2 on feat/intents-v2. Nothing else changes in PaymentIntent before Friday.' },
  {
    ago: 21, from: 'WEB-CHECKOUT', to: 'PAY-SCHEMA', kind: 'request',
    body: "Pointed staging at /v2 and checkout now shows Total $0.00 with\nTypeError: Cannot read properties of undefined (reading 'amount')\n    at formatTotal (src/checkout/OrderSummary.tsx:88:31)\nIs amount_minor nested under amount_details on the create response?",
    media: { file: 'checkout-total-zero.png', mime: PNG, bytes: 236_102, caption: 'Staging checkout showing Total $0.00 with the TypeError from OrderSummary.tsx:88 in the console' },
  },
  { ago: 20, from: 'WEB-CHECKOUT', to: 'owner', kind: 'notice', body: 'Staging checkout broke after the switch: Total $0.00 and a TypeError in OrderSummary.tsx:88. Working it with PAY-SCHEMA now. Production is unaffected (flag off).' },
  {
    ago: 19, from: 'PAY-SCHEMA', to: 'WEB-CHECKOUT', kind: 'response',
    body: 'Create returns it top-level. amount_details only exists on retrieve with expand[]=amount_details, and your formatter still reads intent.amount_details.amount from the old expand path. Use intent.amount_minor on both calls.',
  },
  {
    ago: 17, from: 'WEB-A11Y', to: 'WEB-CHECKOUT', kind: 'request',
    body: 'VoiceOver reads the broken total as "zero dollars" and never announces the error. Recording attached. Put aria-live="polite" on the order total region in OrderSummary.tsx so the corrected total is announced.',
    media: { file: 'voiceover-total.ogg', mime: 'audio/ogg', bytes: 386_400, caption: 'VoiceOver reading the checkout order summary: it announces "Total, zero dollars" and skips the error message' },
  },
  {
    ago: 14, from: 'IOS-CART', to: 'PAY-SCHEMA', kind: 'request',
    body: 'mobile-app feat/cart-v2-intents: the cart shows $12,840.00 for a $128.40 cart. We decode amount_minor into Money(major:) in ios/Cart/CartTotals.swift:57. Is the exponent always 2 for USD, and 0 for JPY?',
    media: { file: 'ios-cart-total.png', mime: PNG, bytes: 954_870, caption: 'iOS simulator cart showing a $12,840.00 total for a $128.40 cart, build 812 on staging' },
  },
  { ago: 12, from: 'PAY-SCHEMA', to: 'IOS-CART', kind: 'response', body: "USD 2, EUR 2, JPY 0, KWD 3, but don't hard-code it: read currency_exponent from the intent. API-SDK is regenerating the Swift and Kotlin clients with a Money type that does this for you." },
  { ago: 11, from: 'API-SDK', to: 'ANDROID-CART', kind: 'notice', body: 'Kotlin client 2.0.0-rc.1 is in the internal Maven repo: Money(amountMinor, currencyExponent).format(locale). Swift package tag 2.0.0-rc.1 too.' },
  { ago: 10.5, from: 'API-SDK', to: 'IOS-CART', kind: 'notice', body: 'Swift package 2.0.0-rc.1 is tagged: Money(amountMinor:currencyExponent:) with a locale-aware formatted(). Drop-in for CartTotals.swift.' },
  {
    ago: 9, from: 'WEB-CHECKOUT', to: 'PAY-SCHEMA', kind: 'notice',
    body: 'Fixed in storefront-web feat/checkout-v2 (3f9e1d0): formatMinor(amount_minor, currency_exponent) in src/lib/money.ts, plus a contract test against openapi/payment_intent.yaml. Staging total is right again: $128.40.',
    media: { file: 'checkout-fixed.png', mime: PNG, bytes: 221_950, caption: 'Staging checkout after the fix: Total $128.40 and a toast confirming the v2 payment intent' },
  },
  {
    ago: 8.8, from: 'WEB-CHECKOUT', to: 'owner', kind: 'notice',
    body: 'Fixed: the staging total is correct again ($128.40), a contract test now pins us to the payments-api spec, and 214 unit tests pass. PR #1873 is up on feat/checkout-v2.',
    media: { file: 'checkout-fixed.png', mime: PNG, bytes: 221_950, caption: 'Staging checkout after the fix: Total $128.40 and a toast confirming the v2 payment intent' },
  },
  { ago: 8, from: 'PAY-SCHEMA', to: 'WEB-CHECKOUT', kind: 'chat', body: 'Confirmed in the payments-api access log: 41 creates from storefront staging since 14:31, all with amount_minor, zero 4xx. Marking storefront as migrated in docs/migrations/intents-v2.md.' },
  { ago: 7, from: 'ANDROID-CART', to: 'API-SDK', kind: 'request', body: 'rc.1 fails to compile: "Unresolved reference: currencyExponent" in PaymentIntentDto.kt:33. Did the generator skip the new field?' },
  { ago: 6, from: 'owner', to: 'WEB-CHECKOUT', kind: 'request', body: 'Nice. Before merging: get WEB-A11Y to check the total announcement, and have WEB-E2E run the checkout suite against staging once CI is back.' },
  { ago: 6, from: 'IOS-CART', to: 'ANDROID-CART', kind: 'chat', body: 'Same bug will hit Android: decode amount_minor with currency_exponent. The iOS fix is 12 lines in CartTotals.swift; the SDK Money type replaces it in rc.2.' },
  { ago: 5, from: 'API-SDK', to: 'ANDROID-CART', kind: 'response', body: 'The generator was pinned to the old spec commit. Regenerated from a91f3c2: 2.0.0-rc.2 is published and has currencyExponent.' },
  { ago: 4.6, from: 'WEB-CHECKOUT', to: 'owner', kind: 'response', body: 'WEB-A11Y already flagged it (VoiceOver read $0.00 as "zero dollars"); the aria-live fix is in #1873. WEB-E2E reran after the CI rollback: 38/38 checkout specs pass on staging. Waiting on review from WEB-CART.' },
  {
    ago: 2, from: 'WEB-CHECKOUT', to: 'PAY-SCHEMA', kind: 'request', unseen: true,
    body: "One more: refunds. PAY-REFUNDS's partial refund endpoint still takes amount in major units in the draft spec. Is the same rename planned? I'd rather not ship two money formats in one release.",
  },
  { ago: 1, from: 'owner', to: 'WEB-CHECKOUT', kind: 'chat', body: 'Approved from my side once WEB-CART signs off. Then take the refunds question to PAY-REFUNDS.', unseen: true },

  // --- The CI outage: platform-infra helps everyone.
  {
    ago: 27, from: 'WEB-E2E', to: 'INFRA-CI', kind: 'request',
    body: 'storefront-web CI: checkout.spec.ts gets killed at random on ci-linux-xl with exit code 137 (OOM). Runs 18342, 18345, 18351. Nothing changed on our side since this morning. Trace recording attached.',
    media: { file: 'checkout-e2e-timeout.webm', mime: 'video/webm', bytes: 18_440_120, caption: 'Screen recording of the Playwright trace: the checkout test stalls on the order summary, then the runner is killed' },
  },
  { ago: 25.5, from: 'MOBILE-RELEASE', to: 'INFRA-CI', kind: 'request', body: "4.12 release train is blocked: ios-build and android-build die with 'The runner has received a shutdown signal' after about 9 minutes, on ci-linux-xl only." },
  { ago: 24.5, from: 'PAY-LOADTEST', to: 'INFRA-CI', kind: 'chat', body: 'Same on payments-api: the k6 smoke job lost its runner twice (jobs 18338, 18349).' },
  { ago: 23.5, from: 'INFRA-CI', to: 'owner', kind: 'notice', body: 'CI incident: ci-linux-xl runners are OOM-killed since the shared pnpm store cache rollout (platform-infra#412) at 14:02. Rolling back; ETA 15 min. macOS runners are fine.' },
  { ago: 23, from: 'owner', to: 'INFRA-CI', kind: 'request', body: 'Roll back first, root-cause later. Post a summary when the pool is green.' },
  {
    ago: 22, from: 'INFRA-CI', to: 'MOBILE-RELEASE', kind: 'notice',
    body: 'Confirmed: ci-linux-xl runners hit the 14 GiB OOM limit since the shared pnpm store cache (platform-infra#412) went out at 14:02. Rolling back now. Memory chart attached.',
    media: { file: 'ci-runner-memory.png', mime: PNG, bytes: 167_220, caption: 'CI runner memory chart: ci-linux-xl p95 climbs from 6 GiB to the 14 GiB OOM line after the 14:02 cache deploy; macOS runners stay flat' },
  },
  {
    ago: 21.8, from: 'INFRA-CI', to: 'WEB-E2E', kind: 'notice',
    body: 'Your exit 137s are ours: the shared pnpm store cache (platform-infra#412) pushes ci-linux-xl runners past 14 GiB. Rolling back now. Memory chart attached.',
    media: { file: 'ci-runner-memory.png', mime: PNG, bytes: 167_220, caption: 'CI runner memory chart: ci-linux-xl p95 climbs from 6 GiB to the 14 GiB OOM line after the 14:02 cache deploy' },
  },
  { ago: 21.6, from: 'INFRA-CI', to: 'PAY-LOADTEST', kind: 'notice', body: 'Known CI incident (runner OOM after platform-infra#412). Rolling back; re-run job 18349 after the all-clear.' },
  { ago: 20, from: 'INFRA-CI', to: 'INFRA-K8S', kind: 'request', body: 'Can you cordon ci-linux-xl-03 and -07? They are swapping hard and keep picking up jobs.' },
  { ago: 19, from: 'INFRA-K8S', to: 'INFRA-CI', kind: 'response', body: 'Cordoned and drained both. Pool is at 10/12; kubectl get nodes -l pool=ci-linux-xl shows the rest Ready.' },
  { ago: 10.2, from: 'INFRA-CI', to: 'MOBILE-RELEASE', kind: 'notice', body: 'Rollback of platform-infra#412 is live (ci-cache v1.8.3). Runner memory is back to ~6 GiB. Re-run your failed jobs; I am watching the pool.' },
  { ago: 10.1, from: 'INFRA-CI', to: 'WEB-E2E', kind: 'notice', body: 'Rollback is live (ci-cache v1.8.3). Re-run 18351.' },
  { ago: 10, from: 'INFRA-CI', to: 'owner', kind: 'notice', body: 'CI is green: #412 rolled back, 12/12 runners healthy. Root cause: the shared store is mounted read-write and every job copies it into tmpfs. Fix tracked in platform-infra#415.' },
  { ago: 9, from: 'WEB-E2E', to: 'INFRA-CI', kind: 'chat', body: 'Run 18351 re-ran green: 38/38 checkout specs pass.' },
  { ago: 4, from: 'MOBILE-RELEASE', to: 'INFRA-CI', kind: 'chat', body: 'ios-build is green on rerun 18377. android-build is still queued behind 23 jobs.' },
  { ago: 3, from: 'MOBILE-RELEASE', to: 'owner', kind: 'request', body: '4.12: iOS is green, Android is still queued behind the CI backlog. Ship iOS alone today, or hold both for tomorrow morning?', unseen: true },

  // --- Latency: payments ledger, observability and the database.
  { ago: 16, from: 'PAY-LEDGER', to: 'INFRA-OBS', kind: 'request', body: 'Can I get a p95 panel for /v2/ledger/reconcile on staging? The k6 run at 2k rps looked slow.' },
  {
    ago: 15, from: 'INFRA-OBS', to: 'PAY-LEDGER', kind: 'response',
    body: 'Added to the payments dashboard. p95 hits ~980 ms during the ramp, over the 800 ms SLO. p50 stays flat, so it is tail latency: probably lock waits.',
    media: { file: 'ledger-latency.png', mime: PNG, bytes: 158_760, caption: 'Latency chart for /v2/ledger/reconcile on staging: p95 rises to about 980 ms during the k6 ramp to 2k rps, over the 800 ms SLO' },
  },
  { ago: 13, from: 'PAY-LEDGER', to: 'INFRA-DB', kind: 'request', body: 'Lock waits on ledger_entries during reconcile. Is staging Postgres on the new 17 instance yet?' },
  { ago: 12, from: 'INFRA-DB', to: 'PAY-LEDGER', kind: 'response', body: 'Not yet, still 15. pg_stat_activity shows reconcile holding a row lock on ledger_accounts for ~800 ms per batch. Try batch size 500 instead of 5000.' },
  { ago: 7.5, from: 'PAY-LEDGER', to: 'PAY-LOADTEST', kind: 'request', body: 'Pushed fix/reconcile-locks with batch size 500. Can you rerun the 2k rps scenario against staging?' },
  { ago: 3.5, from: 'PAY-LOADTEST', to: 'PAY-LEDGER', kind: 'response', body: 'k6 rerun at 2k rps: reconcile p95 410 ms, p99 690 ms, 0.02% errors (all 429s from the fraud rules). Looks good.' },

  // --- Smaller threads and the rest of the Owner traffic.
  { ago: 15, from: 'owner', to: 'PAY-REFUNDS', kind: 'request', body: 'Align the partial refund endpoint with intents v2: amount_minor and currency_exponent, no float amounts.', unseen: true },
  { ago: 18, from: 'MOBILE-CRASH', to: 'MOBILE-RELEASE', kind: 'notice', body: "Top crash in last night's 4.12 TestFlight: EXC_BAD_ACCESS in CartTotalsView.updateTotal(_:), 61 users. Probably the Money decode change; symbolicated log is in the crash thread." },
  { ago: 17.5, from: 'MOBILE-RELEASE', to: 'MOBILE-CRASH', kind: 'response', body: 'Thanks. Holding 4.12 until IOS-CART lands the decode fix.' },
  { ago: 26, from: 'INFRA-CDN', to: 'WEB-PERF', kind: 'notice', body: 'Image CDN now serves AVIF with a WebP fallback for /media/products/*. Cache key includes width, DPR and format.' },
  { ago: 14, from: 'WEB-PERF', to: 'INFRA-CDN', kind: 'request', body: 'LCP on /product pages dropped from 2.9 s to 2.1 s. Could we add a 1 h stale-while-revalidate for /media/hero/*?' },
  { ago: 13.5, from: 'INFRA-CDN', to: 'WEB-PERF', kind: 'response', body: 'Done in platform-infra feat/image-cdn (cdn/rules/storefront.yaml). Live in about 5 minutes.' },
  { ago: 33, from: 'INFRA-SECRETS', to: 'PAY-WEBHOOKS', kind: 'notice', body: 'Staging DB credentials rotate at 15:00 via Vault. Services that read STAGING_DB_URL at boot need a restart afterwards.' },
  { ago: 11, from: 'PAY-WEBHOOKS', to: 'INFRA-SECRETS', kind: 'request', body: 'Webhook worker on staging fails with "password authentication failed for user webhooks". Did the rotation skip the webhooks role?' },
];

/** Background chatter: pairs that talk regularly, with what they say. */
interface Chatter {
  a: string;
  b: string;
  /** Messages over the history window. */
  count: number;
  lines: readonly string[];
}

const CHATTER: readonly Chatter[] = [
  { a: 'WEB-CART', b: 'WEB-CHECKOUT', count: 9, lines: ['Cart drawer now passes priceMinor on every line item; rebase feat/checkout-v2 when you can.', 'Review is up on #1870 (virtualized drawer). Touches src/cart/CartDrawer.tsx only.', 'Re-ran the cart unit tests against your branch: green.'] },
  { a: 'WEB-CHECKOUT', b: 'WEB-E2E', count: 6, lines: ['checkout.spec.ts needs the new data-testid="order-total" from #1873.', 'Added a v2 fixture to tests/fixtures/intents.ts.', 'Staging run is queued behind CI; will report.'] },
  { a: 'WEB-I18N', b: 'WEB-CHECKOUT', count: 4, lines: ['ja-JP has no minor units: make sure formatMinor honours currency_exponent 0.', 'de-DE expects "128,40 €": the formatter should take the locale, not the currency.'] },
  { a: 'WEB-SEARCH', b: 'WEB-PERF', count: 5, lines: ['Facet panel adds 18 KB gzipped; can it lazy-load?', 'Moved facets behind a dynamic import; LCP unchanged on /search.', 'URL state is now in useSearchParams; no extra renders.'] },
  { a: 'DS-TOKENS', b: 'WEB-PERF', count: 4, lines: ['tokens-v3 drops two font weights; preload list in index.html can shrink.', 'Font preload trimmed to Inter 400 and 600.'] },
  { a: 'DS-TOKENS', b: 'IOS-SNAPSHOT', count: 5, lines: ['New spacing scale is in tokens-v3; snapshot baselines will shift by 2 pt.', 'Re-recorded 48 snapshots for dynamic type XXL; diff is spacing only.'] },
  { a: 'DS-TOKENS', b: 'WEB-A11Y', count: 3, lines: ['Is the new muted text colour AA on the panel background?', 'muted-on-panel is 4.9:1: passes AA for body text.'] },
  { a: 'PAY-SCHEMA', b: 'PAY-DOCS', count: 6, lines: ['Changelog entry for intents v2 needs the migration snippet.', 'docs/migrations/intents-v2.md has examples for JS, Swift and Kotlin now.', 'Linked the OpenAPI diff from the changelog.'] },
  { a: 'PAY-SCHEMA', b: 'PAY-REFUNDS', count: 4, lines: ['Refund amounts should follow intents v2: amount_minor plus currency_exponent.', 'Draft spec for POST /v2/refunds updated; please review.'] },
  { a: 'PAY-LEDGER', b: 'PAY-FRAUD', count: 4, lines: ['Velocity rules read ledger_entries; your batch change affects their window.', 'Fraud windows use created_at, not reconcile time: no impact.'] },
  { a: 'PAY-LOADTEST', b: 'PAY-FRAUD', count: 3, lines: ['k6 traffic trips the velocity rule; can you allowlist the load-test cards?', 'Allowlisted test BINs 424242 and 400000 on staging.'] },
  { a: 'PAY-WEBHOOKS', b: 'PAY-SCHEMA', count: 3, lines: ['Webhook payloads for payment_intent.succeeded still carry amount; do they move to v2 too?', 'Yes, v2 events carry amount_minor; v1 events stay as they are until Friday.'] },
  { a: 'API-SDK', b: 'PAY-DOCS', count: 3, lines: ['SDK 2.0 changelog draft is in sdk/CHANGELOG.md.', 'Generated docs for Money are published to the internal portal.'] },
  { a: 'IOS-CART', b: 'MOBILE-OFFLINE', count: 5, lines: ['Offline cart stores totals as Decimal; switching to amountMinor Int64.', 'Conflict resolution now compares amountMinor, not formatted strings.', 'Migration for stored carts is in CartStore+v3.swift.'] },
  { a: 'ANDROID-CART', b: 'MOBILE-OFFLINE', count: 4, lines: ['Room schema bump to v12 for amount_minor.', 'Sync worker retries with backoff; tested airplane mode on a Pixel 8 emulator.'] },
  { a: 'MOBILE-RELEASE', b: 'IOS-CART', count: 4, lines: ['Need the cart fix on release/4.12 by 17:00 for the build.', 'Cherry-picked the decode fix to release/4.12 (b41c07e).'] },
  { a: 'MOBILE-RELEASE', b: 'ANDROID-CART', count: 3, lines: ['Android 4.12 needs SDK rc.2 pinned in gradle/libs.versions.toml.', 'Pinned rc.2; build is queued.'] },
  { a: 'MOBILE-PUSH', b: 'MOBILE-RELEASE', count: 2, lines: ['Deep links for order updates are behind a remote flag for 4.12.'] },
  { a: 'INFRA-CI', b: 'INFRA-K8S', count: 6, lines: ['Runner pool autoscaler min is 8; bump to 12 while the backlog drains?', 'Scaled to 12; nodes join in about 3 minutes.', 'Node pool 1.33 upgrade paused until CI is stable.'] },
  { a: 'INFRA-CI', b: 'INFRA-OBS', count: 5, lines: ['Add an alert on runner memory working set above 12 GiB for 5 min.', 'Alert rule ci-runner-memory-high is live, routed to #ci-alerts.', 'Dashboard CI runners now has the deploy annotations.'] },
  { a: 'INFRA-DB', b: 'INFRA-K8S', count: 4, lines: ['PG17 staging instance needs the new storage class.', 'Storage class premium-rwo-v2 is available in staging.'] },
  { a: 'INFRA-COST', b: 'INFRA-K8S', count: 3, lines: ['Staging node pools cost 31% more since the 1.33 canary; expected?', 'Canary runs double capacity until Thursday; it drops after.'] },
  { a: 'INFRA-OBS', b: 'INFRA-DB', count: 3, lines: ['Exporting pg_stat_statements to the payments dashboard.', 'Lock wait panel added under Postgres > payments.'] },
  { a: 'INFRA-CDN', b: 'INFRA-COST', count: 2, lines: ['CDN egress drops ~40% with AVIF; numbers for the Q4 report.'] },
];

/** Live traffic: chatter pairs plus cross-repo collaborators. The showcased thread is kept quiet. */
const LIVE_EXTRA: readonly Chatter[] = [
  { a: 'IOS-CART', b: 'PAY-SCHEMA', count: 0, lines: ['Swift client rc.2 decodes the sample intents correctly.', 'Snapshot of the v2 sample responses saved under ios/Fixtures/intents-v2/.'] },
  { a: 'ANDROID-CART', b: 'API-SDK', count: 0, lines: ['rc.2 compiles; running the cart instrumentation tests.', 'All 112 cart tests pass on rc.2.'] },
  { a: 'INFRA-CI', b: 'MOBILE-RELEASE', count: 0, lines: ['android-build is next in the queue.', 'Queue depth is down to 9.'] },
  { a: 'INFRA-CI', b: 'WEB-E2E', count: 0, lines: ['Nightly suite rescheduled to 22:00.', 'Runner memory steady at 6 GiB.'] },
  { a: 'PAY-LEDGER', b: 'INFRA-OBS', count: 0, lines: ['Reconcile p95 is flat at ~400 ms after the batch change.', 'Can the SLO panel show the 7-day burn rate?'] },
  { a: 'PAY-LOADTEST', b: 'INFRA-CI', count: 0, lines: ['k6 smoke job is green again.'] },
  { a: 'DS-TOKENS', b: 'IOS-CART', count: 0, lines: ['Cart uses tokens-v3 spacing now.'] },
  { a: 'WEB-PERF', b: 'INFRA-CDN', count: 0, lines: ['Hero images now hit the CDN cache 97% of the time.'] },
];

/** Media lifetime. The scripted expired item is older than this. */
const MEDIA_TTL_MS = DEFAULT_LIMITS.mediaTtlMs;

/**
 * Bundled asset file of a showcase media ID, or undefined. Showcase media IDs
 * are `sc<n>.<file>`, so the web app can map them to static assets.
 */
export function showcaseMediaFile(mediaId: string): string | undefined {
  const m = /^sc\d+\.(.+)$/.exec(mediaId);
  return m ? m[1] : undefined;
}

/** Options for {@link ShowcaseBroker}. */
export interface ShowcaseOptions {
  /** The scenario's "now" on the broker clock. */
  now?: number;
  /** PRNG seed for IDs and live traffic. */
  seed?: number;
}

/**
 * An in-process `/ws/ui` stand-in that plays the showcase scenario. Pure apart
 * from its seeded PRNG: `snapshot`, `step` and `handle` take the time.
 */
export class ShowcaseBroker {
  private readonly random: () => number;
  private readonly mk: ReturnType<typeof createFrameFactory<BrokerToUiFrame>>;
  private readonly limits = { ...DEFAULT_LIMITS };
  private readonly nodes = new Map<string, SessionNode>();
  private readonly byName = new Map<string, string>();
  private readonly edges = new Map<string, EdgeStats>();
  private readonly messages: Message[] = [];
  private readonly media = new Map<string, MediaIndexEntry>();
  private readonly pendingReplies: { due: number; from: string; body: string }[] = [];
  private control: ControlState = { mutedThreads: [], pausedSessions: [], pausedAll: false };
  private clock: number;
  private mediaCounter = 0;
  private storeBytes = 0;
  private readonly live: Chatter[];
  private liveIndex = 0;
  /** Thread kept free of live traffic, so its overlay shows only the story. */
  readonly quietThreads: ReadonlySet<string>;

  /** Builds the cast and replays the scripted history up to `now`. */
  constructor(opts: ShowcaseOptions = {}) {
    this.random = seededRandom(opts.seed ?? 2026);
    const end = opts.now ?? Date.now();
    this.clock = end - 60 * MINUTE;
    this.mk = createFrameFactory<BrokerToUiFrame>('sc', () => this.clock);
    for (const c of CAST) this.addNode(c, end);

    const events: (Line & { ts: number })[] = SCRIPT.map((l) => ({ ...l, ts: end - l.ago * MINUTE }));
    for (const ch of CHATTER) {
      for (let i = 0; i < ch.count; i++) {
        // Spread over the last 36 minutes, denser towards now.
        const f = (i + 0.5 + (this.random() - 0.5) * 0.8) / ch.count;
        const ago = 36 * (1 - Math.sqrt(f)) + 0.4;
        const forward = i % 2 === 0;
        events.push({
          ago,
          ts: end - ago * MINUTE,
          from: forward ? ch.a : ch.b,
          to: forward ? ch.b : ch.a,
          kind: (['chat', 'request', 'response', 'notice'] as const)[i % 4] as MessageKind,
          body: ch.lines[i % ch.lines.length] as string,
        });
      }
    }
    events.sort((x, y) => x.ts - y.ts);
    for (const e of events) {
      this.clock = e.ts;
      this.route(this.addr(e.from), this.addr(e.to), e.kind, e.body, e.media, e.unseen ? undefined : e.ts + (8 + this.random() * 40) * 1000);
    }
    // Seen times must not lie in the future.
    for (const m of this.messages) if (m.seenAt !== undefined && m.seenAt > end) m.seenAt = end;
    this.clock = end;
    this.quietThreads = new Set([
      threadIdFor(this.addr('WEB-CHECKOUT'), this.addr('PAY-SCHEMA')),
      threadIdFor(this.addr('WEB-CHECKOUT'), OWNER_ADDRESS),
    ]);
    this.live = [...CHATTER, ...LIVE_EXTRA].filter((c) => {
      const a = this.nodes.get(this.idOf(c.a));
      const b = this.nodes.get(this.idOf(c.b));
      return a?.connected && b?.connected && !this.quietThreads.has(threadIdFor(this.addr(c.a), this.addr(c.b)));
    });
  }

  private hex(n: number): string {
    let s = '';
    for (let i = 0; i < n; i++) s += '0123456789abcdef'.charAt(Math.floor(this.random() * 16));
    return s;
  }

  private addNode(c: CastMember, end: number): void {
    const host = HOSTS[c.host];
    const id = `${host.hostname}:${this.hex(8)}-${this.hex(4)}-4${this.hex(3)}-a${this.hex(3)}-${this.hex(12)}`;
    const primary = REPOS[c.repos[0] as RepoKey];
    const node: SessionNode = {
      id,
      hostname: host.hostname,
      platform: host.platform,
      name: c.name,
      focus: c.focus,
      repos: c.repos.map((k) => ({ key: REPOS[k], name: repoNameFromKey(REPOS[k]), branch: c.branch })),
      cwd: `${host.home}/${repoNameFromKey(primary)}`,
      status: c.status,
      delivery: c.poll ? 'poll' : 'push',
      connected: !c.offline,
      lastSeen: c.offline ? end - 12 * MINUTE : end,
    };
    this.nodes.set(id, node);
    this.byName.set(c.name, id);
  }

  private idOf(name: string): string {
    const id = this.byName.get(name);
    if (!id) throw new Error(`showcase: unknown cast member ${name}`);
    return id;
  }

  private addr(name: string): Address {
    return name === 'owner' ? OWNER_ADDRESS : sessionAddress(this.idOf(name));
  }

  private nameOf(addr: Address): string {
    return addr.kind === 'owner' ? 'owner' : (this.nodes.get(addr.id)?.name ?? 'unknown');
  }

  private mediaStore() {
    return { bytes: this.storeBytes, capBytes: this.limits.mediaStoreBytes, files: this.media.size };
  }

  private edgeFor(from: Address, to: Address): EdgeStats {
    const threadId = threadIdFor(from, to);
    const existing = this.edges.get(threadId);
    if (existing) return existing;
    const [a, b] = threadId.split('|') as [string, string];
    const edge: EdgeStats = {
      threadId,
      a,
      b,
      weight: 0,
      updatedAt: this.clock,
      lastMessageAt: this.clock,
      sentByA: 0,
      sentByB: 0,
      media: { image: 0, audio: 0, video: 0, other: 0 },
    };
    this.edges.set(threadId, edge);
    return edge;
  }

  /** Routes one message at the current clock and returns the broker's broadcast frames. */
  private route(from: Address, to: Address, kind: MessageKind, body: string, spec?: MediaSpec, seenAt?: number): BrokerToUiFrame[] {
    const prev = this.edgeFor(from, to);
    const id = fakeUlid(this.clock, this.random);
    const attachments: MediaRef[] = [];
    if (spec) {
      const ext = spec.file.split('.').pop() ?? 'bin';
      attachments.push({
        mediaId: `sc${++this.mediaCounter}.${spec.file}`,
        mime: spec.mime,
        filename: spec.file.replace(/\.[^.]+$/, `-${this.mediaCounter}.${ext}`),
        bytes: spec.bytes,
        sha256: this.hex(64),
        caption: spec.caption,
        // Scripted expired items are older than the TTL, so this lies in the past.
        expiresAt: this.clock + MEDIA_TTL_MS,
      });
    }
    const message: Message = {
      id,
      threadId: prev.threadId,
      from,
      fromName: this.nameOf(from),
      to,
      senderKind: from.kind === 'owner' ? 'owner' : 'peer',
      kind,
      body,
      attachments,
      ts: this.clock,
      ...(seenAt !== undefined && to.kind === 'session' ? { seenAt } : {}),
    };
    const fromKey = from.kind === 'owner' ? 'owner' : from.id;
    const bumped = bumpEdge(prev, this.clock, this.limits.edgeTauMs);
    let edge: EdgeStats = {
      ...prev,
      weight: bumped.weight,
      updatedAt: bumped.updatedAt,
      lastMessageAt: this.clock,
      sentByA: prev.sentByA + (fromKey === prev.a ? 1 : 0),
      sentByB: prev.sentByB + (fromKey === prev.b ? 1 : 0),
    };
    this.edges.set(edge.threadId, edge);
    this.messages.push(message);
    const frames: BrokerToUiFrame[] = [this.mk('message', { message, edge })];
    for (const ref of attachments) {
      if (spec?.expired) continue;
      const k = mediaKindOf(ref.mime);
      edge = { ...edge, media: { ...edge.media, [k]: edge.media[k] + 1 } };
      this.edges.set(edge.threadId, edge);
      const entry: MediaIndexEntry = { ref, kind: k, threadId: edge.threadId, messageId: id, from, ts: this.clock };
      this.media.set(ref.mediaId, entry);
      this.storeBytes += ref.bytes;
      frames.push(this.mk('media', { op: 'add', entry, edge, mediaStore: this.mediaStore() }));
    }
    return frames;
  }

  /** The full state as a `snapshot` frame. */
  snapshot(now: number): BrokerToUiFrame {
    this.clock = Math.max(this.clock, now);
    return this.mk('snapshot', {
      brokerVersion: 'showcase',
      protocolVersion: 1,
      now: this.clock,
      limits: this.limits,
      nodes: [...this.nodes.values()],
      edges: [...this.edges.values()],
      messages: this.messages.slice(-2000),
      media: [...this.media.values()],
      control: this.control,
      mediaStore: this.mediaStore(),
    });
  }

  /** Advances to `now` and returns the next live event: mostly peer chatter, now and then an Owner halo. */
  step(now: number): BrokerToUiFrame[] {
    this.clock = Math.max(this.clock, now);
    const frames: BrokerToUiFrame[] = [];
    while (this.pendingReplies.length > 0 && (this.pendingReplies[0] as { due: number }).due <= this.clock) {
      const r = this.pendingReplies.shift() as { from: string; body: string };
      frames.push(...this.route(sessionAddress(r.from), OWNER_ADDRESS, 'response', r.body));
    }
    if (this.control.pausedAll || this.live.length === 0) return frames;
    // Walk the live pairs in a shuffled-but-deterministic order so pulses spread over the graph.
    this.liveIndex = (this.liveIndex + 1 + Math.floor(this.random() * 5)) % this.live.length;
    const c = this.live[this.liveIndex] as Chatter;
    const forward = this.random() < 0.5;
    const from = this.addr(forward ? c.a : c.b);
    const to = this.addr(forward ? c.b : c.a);
    if (from.kind === 'session' && this.control.pausedSessions.includes(from.id)) return frames;
    if (this.control.mutedThreads.includes(threadIdFor(from, to))) return frames;
    const kind = (['chat', 'chat', 'request', 'response', 'notice'] as const)[Math.floor(this.random() * 5)] as MessageKind;
    frames.push(...this.route(from, to, kind, c.lines[Math.floor(this.random() * c.lines.length)] as string));
    return frames;
  }

  /** Handles one raw frame from the web app; returns the broker's answers. */
  handle(raw: string, now: number): BrokerToUiFrame[] {
    this.clock = Math.max(this.clock, now);
    const result = decodeFrame(UiToBrokerFrameSchema, raw);
    if (!result.ok) return [this.mk('rejected', { re: result.id, code: 'invalid', detail: result.error.slice(0, 1024) })];
    const f = result.frame;
    switch (f.type) {
      case 'ping':
        return [this.mk('pong', { re: f.id })];
      case 'pong':
        return [];
      case 'control': {
        const c = { ...this.control };
        const p = f.payload;
        if (p.action === 'pause_all') c.pausedAll = true;
        else if (p.action === 'resume_all') c.pausedAll = false;
        else if (p.action === 'mute_thread') c.mutedThreads = [...new Set([...c.mutedThreads, p.threadId])];
        else if (p.action === 'unmute_thread') c.mutedThreads = c.mutedThreads.filter((t) => t !== p.threadId);
        else if (p.action === 'pause_session') c.pausedSessions = [...new Set([...c.pausedSessions, p.sessionId])];
        else c.pausedSessions = c.pausedSessions.filter((s) => s !== p.sessionId);
        this.control = c;
        return [this.mk('control_state', c)];
      }
      case 'owner_send': {
        const target = this.nodes.get(f.payload.to);
        if (!target) return [this.mk('rejected', { re: f.id, code: 'unknown_recipient', detail: 'No such session.' })];
        const frames = this.route(OWNER_ADDRESS, sessionAddress(target.id), f.payload.kind, f.payload.body);
        const first = frames[0];
        if (first?.type === 'message') {
          frames.unshift(this.mk('sent', { re: f.id, messageId: first.payload.message.id, threadId: first.payload.message.threadId, ts: this.clock }));
        }
        if (target.connected) {
          this.pendingReplies.push({
            due: this.clock + (target.delivery === 'poll' ? 6000 : 1800),
            from: target.id,
            body: `${target.name} here: got it. This is the showcase scenario, so this reply is canned; a real session would act on your message and report back.`,
          });
        }
        return frames;
      }
    }
  }
}

/** Options for {@link showcaseTransport}. */
export interface ShowcaseTransportOptions extends ShowcaseOptions {
  /** Mean interval between live events, in ms. */
  intervalMs?: number;
  /**
   * Local time of day the scenario plays at, as [hours, minutes]. The story
   * mentions wall-clock times (a 14:02 deploy, staging at 14:00), so the
   * broker clock is shifted to match whatever the real time is. Default 14:40.
   */
  timeOfDay?: [number, number];
}

/**
 * A {@link TransportFactory} backed by one {@link ShowcaseBroker}, delivering
 * frames as JSON text so the app's decode and validation path runs exactly as
 * in production.
 */
export function showcaseTransport(opts: ShowcaseTransportOptions = {}): TransportFactory {
  const [hh, mm] = opts.timeOfDay ?? [14, 40];
  const anchor = new Date();
  anchor.setHours(hh, mm, 0, 0);
  const offset = anchor.getTime() - Date.now();
  const clock = () => Date.now() + offset;
  const broker = new ShowcaseBroker({ ...opts, now: opts.now ?? clock() });
  const interval = opts.intervalMs ?? 150;
  return (handlers) => {
    let open = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const emit = (frames: BrokerToUiFrame[]) => {
      for (const f of frames) if (open) handlers.onMessage(encodeFrame(f));
    };
    const loop = () => {
      if (!open) return;
      emit(broker.step(clock()));
      timer = setTimeout(loop, interval * (0.5 + Math.random()));
    };
    setTimeout(() => {
      if (!open) return;
      handlers.onOpen();
      emit([broker.snapshot(clock())]);
      timer = setTimeout(loop, interval);
    }, 50);
    return {
      send(raw) {
        if (open) setTimeout(() => emit(broker.handle(raw, clock())), 20);
      },
      close() {
        if (!open) return;
        open = false;
        if (timer) clearTimeout(timer);
        handlers.onClose({ code: 1000, opened: true });
      },
    } satisfies Transport;
  };
}
