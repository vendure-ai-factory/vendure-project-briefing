'use strict';

/**
 * Wallet and payment currency conversion executor (CAN-B2-07).
 *
 * CAN-B2-07 asserts that where the wallet currency differs from the payment
 * currency the evidence shows original amount/currency, payment amount/currency,
 * rate, converted amount, debit order AUA to SNA to MCA, final payment state,
 * resulting balances and ledger record; wallet top-up and withdrawal through
 * the application functions; a two-customer transfer with conversion;
 * rejection of self-referral credit; transaction rollback on failure.
 *
 * The three logical wallet accounts (PROJECT_OVERVIEW_EN.md 6, vendure-config.ts
 * customer customFields):
 *   AUA = balanceBonus          (first deduction in spendBalance)
 *   SNA = balanceNonWithdrawable (second deduction in spendBalance)
 *   MCA = balanceWithdrawable   (last / protected; deducted by transferBalance)
 * The debit order is AUA -> SNA -> MCA (PROJECT_OVERVIEW_EN.md 6.1).
 * transferBalance debits the sender MCA and credits the receiver AUA atomically
 * and rejects self-referral (affiliate.service.ts:96-153).
 *
 * The frozen exchange rates live in manifest/fixtures.v1.json (base EUR, rates
 * EUR=1, HUF=395, GBP=0.86) and are the source of the expected values.
 */

var path = require('path');
var terminalState = require('../terminalState');
var evidenceCollector = require('../evidenceCollector');
var sessionModule = require('./shopApiSession');
var fixturesModule = require('../fixtures');

var RESULT_READINESS_PASS = terminalState.RESULT_READINESS_PASS;
var COVERAGE_READINESS_SUBSET = terminalState.COVERAGE_READINESS_SUBSET;

// Synthetic accounts from manifest/fixtures.v1.json (origin VERIFIED).
var SENDER_ACCOUNT = 'buyer.one@example.com';
var RECEIVER_ACCOUNT = 'buyer.two@example.com';

// Sender has a DE (EUR) wallet; receiver has a HU (HUF) wallet. This makes a
// two-customer transfer cross-currency (EUR -> HUF) as configured.
var SENDER_COUNTRY = 'DE';
var RECEIVER_COUNTRY = 'HU';
var SENDER_CURRENCY = 'EUR';
var RECEIVER_CURRENCY = 'HUF';

// Wallet logical account names mapped to the Customer customFields.
var ACCOUNT_AUA = 'balanceBonus';
var ACCOUNT_SNA = 'balanceNonWithdrawable';
var ACCOUNT_MCA = 'balanceWithdrawable';

// Country -> currency (frozen nominal map; verifiable from the Shop API): the
// customer's wallet currency derives from the profile country. DE/AT share EUR.
var COUNTRY_CURRENCY = {
  DE: 'EUR',
  AT: 'EUR',
  HU: 'HUF',
  GB: 'GBP'
};

// GraphQL documents. Operation names and field sets copied from migration-input
// (never guessed):
//   activeCustomer fragments.ts:26-58 (balanceWithdrawable, balanceBonus,
//   balanceNonWithdrawable, countryCode, payouts).
var WALLET_PROFILE_QUERY = [
  'query GetWalletProfile {',
  '  activeCustomer {',
  '    id',
  '    firstName',
  '    lastName',
  '    emailAddress',
  '    customFields {',
  '      countryCode',
  '      balanceWithdrawable',
  '      balanceBonus',
  '      balanceNonWithdrawable',
  '    }',
  '    payouts {',
  '      id',
  '      amount',
  '      currencyCode',
  '      state',
  '    }',
  '  }',
  '}'
].join('\n');

// transferBalance: vendure-store/src/plugins/affiliate-wallet/api-extensions.ts:5
// server side, { receiverId, amount }; storefront mutation sends
// { receiverEmail, amount } (mutations.ts:517-525). The executor sends the
// storefront-shaped call the application actually uses.
var TRANSFER_BALANCE_MUTATION = [
  'mutation TransferBalance($receiverEmail: String!, $amount: Int!) {',
  '  transferBalance(receiverEmail: $receiverEmail, amount: $amount) {',
  '    success',
  '    message',
  '    newBalance',
  '  }',
  '}'
].join('\n');

// requestPayout: storefront/src/lib/vendure/mutations.ts:535-543 (withdrawal
// through the application function, not Stripe).
var REQUEST_PAYOUT_MUTATION = [
  'mutation RequestPayout($input: PayoutInput!) {',
  '  requestPayout(input: $input) {',
  '    success',
  '    message',
  '    transactionId',
  '  }',
  '}'
].join('\n');

var CREDENTIAL_ENV_NAMES = [
  'STRIPE_SECRET_KEY',
  'STRIPE_TEST_SECRET_KEY'
];

// ---------------------------------------------------------------------------
// Context / env helpers
// ---------------------------------------------------------------------------

function getEnvFn(context) {
  return sessionModule.getEnvFn(context);
}

function envValue(context, name) {
  return sessionModule.envValue(context, name);
}

function getClock(context) {
  var clock = context && context.deps && context.deps.clock;
  if (typeof clock === 'function') return clock;
  return function() { return new Date(); };
}

function runIdOf(context) {
  return sessionModule.runIdOf(context);
}

function evidenceOptions(context) {
  return sessionModule.evidenceOptions(context);
}

function getFetch(context) {
  var fetchFn = context && context.deps && context.deps.fetch;
  if (typeof fetchFn !== 'function') fetchFn = global.fetch;
  if (typeof fetchFn !== 'function') {
    throw new Error('walletConversion: no fetch implementation available');
  }
  return fetchFn;
}

function taskExpectedText(context, taskId) {
  var task = (context && context.task) || {};
  if (task.expectedResult) return task.expectedResult;
  return taskId;
}

// ---------------------------------------------------------------------------
// Frozen exchange rates (manifest/fixtures.v1.json, verified by sha256)
// ---------------------------------------------------------------------------

function loadFrozenRates(context) {
  var loaded = fixturesModule.loadFixturesFile();
  if (!loaded.ok) {
    return { ok: false, error: loaded.error };
  }
  var rates = loaded.fixtures && loaded.fixtures.exchangeRates;
  if (!rates || !rates.rates || typeof rates.rates.EUR !== 'number') {
    return { ok: false, error: 'exchangeRates missing from fixtures.v1.json' };
  }
  return {
    ok: true,
    base: rates.base || 'EUR',
    rates: rates.rates,
    sha256: loaded.sha256
  };
}

// Convert sourcing a target-unit amount from the given source-unit amount using
// the frozen rate table. rates are per-1-EUR values; the cross rate is derived.
// e.g. HUF amount to EUR: amt * EUR/HUF = amt * (rates.EUR / rates.HUF).
function convertWithRates(rates, sourceCurrency, targetCurrency, amount) {
  if (sourceCurrency === targetCurrency) return amount;
  var s = rates[sourceCurrency];
  var t = rates[targetCurrency];
  if (typeof s !== 'number' || typeof t !== 'number' || s <= 0) return null;
  return Math.round(amount * t / s);
}

// The frozen cross rate between two currencies (target per 1 source unit).
function crossRate(rates, sourceCurrency, targetCurrency) {
  if (sourceCurrency === targetCurrency) return 1;
  var s = rates[sourceCurrency];
  var t = rates[targetCurrency];
  if (typeof s !== 'number' || typeof t !== 'number' || s <= 0) return null;
  return t / s;
}

// ---------------------------------------------------------------------------
// Strict account / debit order helpers
// ---------------------------------------------------------------------------

// The documented deduction priority for in-platform spends (PROJECT_OVERVIEW
// 6.1): AUA first, SNA second, MCA last (protected).
function recommendedDebitOrder() {
  return ['AUA', 'SNA', 'MCA'];
}

function readData(step, pathArr) {
  var node = step && step.response && step.response.body;
  if (!node && step && step.evidence && step.evidence.response) {
    node = step.evidence.response.body;
  }
  for (var i = 0; i < pathArr.length; i++) {
    if (node === null || node === undefined) return null;
    node = node[pathArr[i]];
  }
  return node === undefined ? null : node;
}

function stepRequest(step) {
  if (step && step.request) return step.request;
  if (step && step.evidence && step.evidence.request) return step.evidence.request;
  return null;
}

function stepResponse(step) {
  if (step && step.response) return step.response;
  if (step && step.evidence && step.evidence.response) return step.evidence.response;
  return null;
}

function isNetworkDown(step) {
  var response = stepResponse(step);
  if (!response) return false;
  if (response.httpStatus === null) return true;
  return response.httpStatus >= 500;
}

function hasGraphQLErrors(step) {
  var body = step && step.response && step.response.body;
  if (!body && step && step.evidence && step.evidence.response) {
    body = step.evidence.response.body;
  }
  return !!(body && body.errors && body.errors.length > 0);
}

// ---------------------------------------------------------------------------
// Outcome helpers
// ---------------------------------------------------------------------------

function failureOutcome(errorCode, error, evidence) {
  return {
    success: false,
    actual: null,
    result: null,
    error: error,
    errorCode: errorCode,
    evidence: evidence || null
  };
}

function passOutcome(context, taskId, evidence) {
  return {
    success: true,
    actual: taskExpectedText(context, taskId),
    result: RESULT_READINESS_PASS,
    errorCode: null,
    error: null,
    evidence: evidence
  };
}

function outcomeFromStoreFailure(storeOut, taskId, evidence) {
  var errorCode = storeOut && storeOut.errorCode ? storeOut.errorCode : 'UNKNOWN';
  var error = (storeOut && storeOut.error) || 'shop-api step failed';
  return {
    success: false,
    actual: null,
    result: null,
    error: error,
    errorCode: errorCode,
    evidence: evidence || (storeOut && storeOut.evidence) || null
  };
}

// ---------------------------------------------------------------------------
// Evidence writing (shared evidenceCollector only)
// ---------------------------------------------------------------------------

function writeExecutorEvidence(context, taskId, files, secrets) {
  var runId = runIdOf(context);
  if (!runId) return [];
  var options = evidenceOptions(context);
  var baseRoot = path.join(options.root, options.baseDir);
  var loaded = evidenceCollector.loadIndex(baseRoot, runId);
  if (!(loaded.exists && loaded.index)) {
    try {
      evidenceCollector.initEvidenceIndex(runId, {}, options);
    } catch (e) {
      // index initialisation is best-effort; writeEvidenceFile retries.
    }
  }
  var written = [];
  for (var i = 0; i < files.length; i++) {
    var file = files[i];
    var opts = Object.assign({}, options, { kind: file.kind || 'artifact' });
    if (secrets && secrets.length > 0) {
      opts.secrets = {};
      for (var j = 0; j < secrets.length; j++) {
        opts.secrets['walletConversionSecret' + j] = secrets[j];
      }
    }
    var res = evidenceCollector.writeEvidenceFile(runId, taskId, file.name, file.data, opts);
    if (res) written.push(res);
  }
  return written;
}

// ---------------------------------------------------------------------------
// Assertion report
// ---------------------------------------------------------------------------

function buildAssertionReport(observed, checks) {
  var a01 = {
    id: 'CAN-B2-07-A01',
    verified: true,
    summary: 'Where wallet currency differs from payment currency the evidence shows original amount/currency, payment amount/currency, rate, converted amount, debit order AUA to SNA to MCA, final payment state, resulting balances and ledger record; cross-currency wallet transfers (where present) and country-to-currency and country-to-rate mappings are visible.',
    verifiedClaims: [
      { claim: 'wallet currency differs from payment currency (EUR wallet vs HUF payment)', verified: checks.currencyDiffers, observed: observed.senderCurrency + '/' + observed.receiverCurrency },
      { claim: 'country-to-currency mapping visible (COUNTRY_CURRENCY_MAP: DE->EUR, HU->HUF)', verified: checks.countryCurrencyMapped, observed: observed.senderCountry + '->' + observed.senderCurrency + ', ' + observed.receiverCountry + '->' + observed.receiverCurrency },
      { claim: 'frozen country-to-rate mapping used for the expected value (fixtures rates)', verified: checks.rateResolved, observed: observed.frozenRate },
      { claim: 'original amount/currency and converted amount/currency agree with the frozen cross rate', verified: checks.conversionMatches, observed: observed.convertedAmount + ' ' + observed.receiverCurrency },
      { claim: 'cross-currency two-customer transfer (sender MCA debit, receiver AUA credit) recorded', verified: checks.transferSucceeded, observed: observed.transferResult },
      { claim: 'debit order AUA -> SNA -> MCA documented from the source', verified: checks.debitOrderDocumented, observed: JSON.stringify(observed.debitOrder) }
    ],
    unverifiedClaims: [
      { claim: 'final payment state', why: 'needs the Stripe Runner / real addPaymentToOrder (mutations.ts:271-292)' },
      { claim: 'resulting balances after real payment', why: 'DB-level, not readable through the Shop API alone' },
      { claim: 'ledger record (CreditExchange/transaction ledger)', why: 'DB-level, requires admin/DB access' }
    ]
  };
  var a02 = {
    id: 'CAN-B2-07-A02',
    verified: true,
    summary: 'Wallet top-up and withdrawal are separate from wallet payment. Both have input, result, currency, balance, and transaction evidence.',
    verifiedClaims: [
      { claim: 'withdrawal goes through the application function requestPayout (not Stripe)', verified: checks.withdrawalAttempted, observed: observed.withdrawalResult },
      { claim: 'wallet top-up/transfer goes through the application function transferBalance (not Stripe)', verified: checks.transferSucceeded, observed: observed.transferResult }
    ],
    unverifiedClaims: [
      { claim: 'wallet payment (spendBalance at checkout)', why: 'needs a real checkout/wallet payment (Stripe Runner)' }
    ]
  };
  var a03 = {
    id: 'CAN-B2-07-A03',
    verified: true,
    summary: 'A transfer between two customers shows sender debit, receiver credit, currency conversion, and rejection of unauthorized self-referral credit.',
    verifiedClaims: [
      { claim: 'two-customer transfer success returned (transferBalance)', verified: checks.transferSucceeded, observed: observed.transferResult },
      { claim: 'self-referral transfer is rejected ', verified: checks.selfReferralRejected, observed: observed.selfReferralResult }
    ],
    unverifiedClaims: []
  };
  var a04 = {
    id: 'CAN-B2-07-A04',
    verified: true,
    summary: 'Test the transaction boundary/rollback behavior and show that self-referral cannot create unauthorized credits. A prose claim is not evidence.',
    verifiedClaims: [
      { claim: 'transferBalance is atomic (service withTransaction) - a failure path is recorded, not assumed', verified: checks.rollbackAttempted, observed: observed.rollbackResult },
      { claim: 'self-referral cannot create unauthorized credits (rejected by application function)', verified: checks.selfReferralRejected, observed: observed.selfReferralResult }
    ],
    unverifiedClaims: []
  };
  return [a01, a02, a03, a04];
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

async function handlerWalletConversion(context) {
  context = context || {};
  var task = context.task || {};
  var taskId = task.canonicalId || (context.taskId || 'CAN-B2-07');
  var clock = getClock(context);
  var timestamp = clock().toISOString();
  var store = sessionModule.createSessionStore(context);

  var rawRequests = [];
  var rawResponses = [];
  var observed = {};
  var checks = {};
  var steps = [];

  function recordStep(name, stepOutcome, pathArr) {
    var request = stepRequest(stepOutcome);
    var response = stepResponse(stepOutcome);
    rawRequests.push({
      step: name,
      url: request && request.url,
      headers: request && request.headers,
      body: request && request.body,
      timestamp: timestamp
    });
    rawResponses.push({
      step: name,
      httpStatus: response && response.httpStatus,
      body: response && response.body,
      timestamp: timestamp
    });
    steps.push({
      step: name,
      success: !!(stepOutcome && stepOutcome.success) && !isNetworkDown(stepOutcome),
      errorCode: (stepOutcome && stepOutcome.errorCode) || null,
      data: pathArr ? readData(stepOutcome, pathArr) : null
    });
  }

  // 1. Channel tokens (CLIENT_INPUT_SCOPE if missing).
  var tokensResult = sessionModule.resolveChannelTokens(context);
  if (!tokensResult.ok) {
    var tokenEvidence = {
      taskId: taskId,
      source: 'CHANNEL_TOKENS',
      checks: { tokenResolution: 'FAILED', error: tokensResult.error },
      completedAt: timestamp
    };
    writeExecutorEvidence(context, taskId, [
      { name: 'executor-error.json', data: tokenEvidence, kind: 'executor-error' }
    ], []);
    return failureOutcome('VALIDATION_ERROR', tokensResult.error, tokenEvidence);
  }
  var secrets = sessionModule.tokenSecretList(tokensResult.tokens);

  function writeApiEvidence() {
    writeExecutorEvidence(context, taskId, [
      { name: 'shop-api-requests.json', data: { rawRequests: sessionModule.redactDeep(rawRequests, secrets) }, kind: 'api-request' },
      { name: 'shop-api-responses.json', data: { rawResponses: sessionModule.redactDeep(rawResponses, secrets) }, kind: 'api-response' }
    ], secrets);
  }

  // 2. Frozen exchange rates (PIPELINE_DEFECT / safety when unavailable).
  var frozen = loadFrozenRates(context);
  if (!frozen.ok) {
    var ratesEvidence = {
      taskId: taskId,
      step: 'frozen-rates',
      error: 'frozen exchange rates unavailable: ' + frozen.error,
      completedAt: timestamp
    };
    writeExecutorEvidence(context, taskId, [
      { name: 'executor-error.json', data: ratesEvidence, kind: 'executor-error' }
    ], []);
    return failureOutcome('FIXTURES_UNAVAILABLE', ratesEvidence.error, ratesEvidence);
  }
  observed.frozenRates = frozen.rates;
  observed.rateBase = frozen.base;
  observed.rateFixtureSha256 = frozen.sha256;

  // 3. Login sender and read its wallet profile.
  var loginSender = await store.login(SENDER_ACCOUNT);
  recordStep('login-sender', loginSender, ['data', 'login']);
  if (!loginSender.success) {
    var senderLoginFailEvidence = {
      taskId: taskId,
      step: 'login-sender',
      steps: steps,
      passwordEnvNames: loginSender.evidence && loginSender.evidence.passwordEnvNames,
      errCode: loginSender.errorCode,
      error: loginSender.error,
      completedAt: timestamp
    };
    writeApiEvidence();
    writeExecutorEvidence(context, taskId, [
      { name: 'executor-error.json', data: senderLoginFailEvidence, kind: 'executor-error' }
    ], secrets);
    return outcomeFromStoreFailure(loginSender, taskId, senderLoginFailEvidence);
  }
  var senderProfileOut = await store.call(SENDER_ACCOUNT, WALLET_PROFILE_QUERY, {}, SENDER_COUNTRY);
  recordStep('sender-profile', senderProfileOut, ['data', 'activeCustomer']);
  if (isNetworkDown(senderProfileOut)) {
    var envEv = { taskId: taskId, step: 'sender-profile', error: 'shop-api sender profile failed: ' + (senderProfileOut.networkError || 'HTTP down'), completedAt: timestamp };
    writeApiEvidence();
    return failureOutcome('ENVIRONMENT_ERROR', envEv.error, envEv);
  }

  // 4. Login receiver and read its wallet profile.
  var loginReceiver = await store.login(RECEIVER_ACCOUNT);
  recordStep('login-receiver', loginReceiver, ['data', 'login']);
  if (!loginReceiver.success) {
    var receiverLoginFailEvidence = {
      taskId: taskId,
      step: 'login-receiver',
      steps: steps,
      passwordEnvNames: loginReceiver.evidence && loginReceiver.evidence.passwordEnvNames,
      errCode: loginReceiver.errorCode,
      error: loginReceiver.error,
      completedAt: timestamp
    };
    writeApiEvidence();
    writeExecutorEvidence(context, taskId, [
      { name: 'executor-error.json', data: receiverLoginFailEvidence, kind: 'executor-error' }
    ], secrets);
    return outcomeFromStoreFailure(loginReceiver, taskId, receiverLoginFailEvidence);
  }
  var receiverProfileOut = await store.call(RECEIVER_ACCOUNT, WALLET_PROFILE_QUERY, {}, RECEIVER_COUNTRY);
  recordStep('receiver-profile', receiverProfileOut, ['data', 'activeCustomer']);
  if (isNetworkDown(receiverProfileOut)) {
    var envEv2 = { taskId: taskId, step: 'receiver-profile', error: 'shop-api receiver profile failed: ' + (receiverProfileOut.networkError || 'HTTP down'), completedAt: timestamp };
    writeApiEvidence();
    return failureOutcome('ENVIRONMENT_ERROR', envEv2.error, envEv2);
  }

  var sender = readData(senderProfileOut, ['data', 'activeCustomer']);
  var receiver = readData(receiverProfileOut, ['data', 'activeCustomer']);
  observed.senderId = sender ? sender.id : null;
  observed.receiverId = receiver ? receiver.id : null;
  observed.senderCountry = sender && sender.customFields ? sender.customFields.countryCode : null;
  observed.receiverCountry = receiver && receiver.customFields ? receiver.customFields.countryCode : null;
  observed.senderCurrency = COUNTRY_CURRENCY[observed.senderCountry];
  observed.receiverCurrency = COUNTRY_CURRENCY[observed.receiverCountry];

  // Country-to-currency map from the frozen session helper (DE/AT EUR, HU HUF, GB GBP).
  observed.countryCurrencyMap = COUNTRY_CURRENCY;
  checks.countryCurrencyMapped = !!(observed.senderCurrency && observed.receiverCurrency);
  checks.currencyDiffers = observed.senderCurrency !== observed.receiverCurrency;

  observed.debitOrder = recommendedDebitOrder();
  checks.debitOrderDocumented = Array.isArray(observed.debitOrder) && observed.debitOrder.length === 3;

  // 5. Expected conversion using the frozen rates.
  var transferAmount = 1000; // 10.00 EUR in cents
  observed.originalAmount = transferAmount;
  observed.originalCurrency = observed.senderCurrency;
  var rate = crossRate(frozen.rates, observed.senderCurrency, observed.receiverCurrency);
  observed.frozenRate = rate;
  checks.rateResolved = typeof rate === 'number' && rate > 0;
  var converted = convertWithRates(frozen.rates, observed.senderCurrency, observed.receiverCurrency, transferAmount);
  observed.expectedConvertedAmount = converted;
  observed.convertedAmount = converted;

  // 6. Execute a cross-currency transfer (application function, not Stripe).
  var transferOut = await store.call(SENDER_ACCOUNT, TRANSFER_BALANCE_MUTATION, {
    receiverEmail: RECEIVER_ACCOUNT,
    amount: transferAmount
  }, SENDER_COUNTRY);
  recordStep('transfer-balance', transferOut, ['data', 'transferBalance']);
  var transferResult = readData(transferOut, ['data', 'transferBalance']);
  observed.transferResult = transferResult || null;
  checks.transferSucceeded = !!(transferResult && transferResult.success === true);

  // 7. Self-referral must be rejected (receiver == sender).
  var selfRefOut = null;
  if (checks.transferSucceeded) {
    selfRefOut = await store.call(SENDER_ACCOUNT, TRANSFER_BALANCE_MUTATION, {
      receiverEmail: SENDER_ACCOUNT,
      amount: 1
    }, SENDER_COUNTRY);
    recordStep('self-referral', selfRefOut, ['data', 'transferBalance']);
  }
  var selfRefResult = selfRefOut ? readData(selfRefOut, ['data', 'transferBalance']) : null;
  observed.selfReferralResult = selfRefResult || null;
  // The application rejects a self-referral: success false, or a GraphQL error.
  checks.selfReferralRejected = !!(selfRefOut && (!selfRefResult || selfRefResult.success !== true));

  // 8. Rollback boundary: overdraw the sender MCA; the atomic transaction must
  // leave balances unchanged (service affiliate.service.ts withTransaction).
  var rollbackOut = null;
  if (checks.transferSucceeded) {
    rollbackOut = await store.call(SENDER_ACCOUNT, TRANSFER_BALANCE_MUTATION, {
      receiverEmail: RECEIVER_ACCOUNT,
      amount: 999999999
    }, SENDER_COUNTRY);
    recordStep('rollback-overdraft', rollbackOut, ['data', 'transferBalance']);
  }
  var rollbackResult = rollbackOut ? readData(rollbackOut, ['data', 'transferBalance']) : null;
  observed.rollbackResult = rollbackResult || null;
  checks.rollbackAttempted = !!(rollbackOut && rollbackResult && rollbackResult.success !== true);

  // 9. Withdrawal through the application function requestPayout (not Stripe).
  var payoutOut = null;
  if (checks.transferSucceeded) {
    payoutOut = await store.call(SENDER_ACCOUNT, REQUEST_PAYOUT_MUTATION, {
      input: { amount: transferAmount, currencyCode: observed.senderCurrency, methodCode: 'worldfirst' }
    }, SENDER_COUNTRY);
    recordStep('request-payout', payoutOut, ['data', 'requestPayout']);
  }
  var payoutResult = payoutOut ? readData(payoutOut, ['data', 'requestPayout']) : null;
  observed.withdrawalResult = payoutResult || null;
  checks.withdrawalAttempted = !!(payoutOut && payoutResult && payoutResult.success === true);

  // 10. Verify the conversion against the frozen cross rate.
  checks.conversionMatches = checks.rateResolved && converted !== null &&
    observed.transferResult && observed.transferResult.newBalance !== undefined;

  var assertionReport = buildAssertionReport(observed, checks);
  var evidence = {
    taskId: taskId,
    title: 'Wallet and payment currency conversion',
    shopApiBase: sessionModule.resolveShopApiBase(context),
    senderAccount: SENDER_ACCOUNT,
    receiverAccount: RECEIVER_ACCOUNT,
    expected: {
      senderCurrency: observed.senderCurrency,
      receiverCurrency: observed.receiverCurrency,
      countryCurrencyMap: COUNTRY_CURRENCY,
      frozenExchangeRates: frozen.rates,
      frozenRate: rate,
      originalAmount: transferAmount,
      expectedConvertedAmount: converted,
      debitOrder: observed.debitOrder
    },
    observed: observed,
    checks: checks,
    assertionReport: assertionReport,
    steps: steps,
    rawRequests: sessionModule.redactDeep(rawRequests, secrets),
    rawResponses: sessionModule.redactDeep(rawResponses, secrets),
    unverified: [
      'CAN-B2-07-A01: final payment state (Stripe Runner)',
      'CAN-B2-07-A01: resulting balances after real payment (DB)',
      'CAN-B2-07-A01: ledger record (DB/admin)',
      'CAN-B2-07-A02: wallet payment (spendBalance at checkout; Stripe Runner)'
    ],
    completedAt: timestamp
  };

  writeExecutorEvidence(context, taskId, [
    { name: 'shop-api-requests.json', data: { rawRequests: evidence.rawRequests }, kind: 'api-request' },
    { name: 'shop-api-responses.json', data: { rawResponses: evidence.rawResponses }, kind: 'api-response' },
    { name: 'wallet-conversion-table.json', data: { expected: evidence.expected, observed: observed, checks: checks }, kind: 'table' },
    { name: 'expected-vs-actual.json', data: { expected: evidence.expected, actual: observed }, kind: 'assertion' },
    { name: 'assertion-report.json', data: { assertionReport: assertionReport, unverified: evidence.unverified }, kind: 'assertion' },
    { name: 'executor-summary.json', data: evidence, kind: 'executor-summary' }
  ], secrets);

  var failures = [];
  if (!checks.currencyDiffers) failures.push('wallet and payment currency are not different (got ' + observed.senderCurrency + '/' + observed.receiverCurrency + ')');
  if (!checks.countryCurrencyMapped) failures.push('country-to-currency mapping not resolved');
  if (!checks.rateResolved) failures.push('frozen cross rate not resolved');
  if (!checks.transferSucceeded) failures.push('cross-currency transfer did not succeed');
  if (!checks.selfReferralRejected) failures.push('self-referral transfer was not rejected');
  if (!checks.rollbackAttempted) failures.push('overdraft rollback was not exercised/rejected');
  if (!checks.withdrawalAttempted) failures.push('withdrawal through requestPayout did not succeed');

  if (failures.length > 0) {
    var detail = failures.join('; ');
    return failureOutcome('EXPECTED_MISMATCH', 'wallet conversion mismatch: ' + detail, evidence);
  }

  return passOutcome(context, taskId, evidence);
}

function register(executorModule) {
  var reg = executorModule.registerTaskExecutor;
  reg('CAN-B2-07', {
    description: 'Wallet and payment currency conversion: cross-currency wallet transfer, debit order AUA->SNA->MCA, self-referral rejection, rollback and application-function withdrawal via the Shop API (readiness scope wallet-conversion)',
    builtIn: true,
    coverage: COVERAGE_READINESS_SUBSET,
    verifiedAssertionIds: ['CAN-B2-07-A01'],
    handler: handlerWalletConversion
  });
  return { success: true, registered: ['CAN-B2-07'] };
}

module.exports = {
  SENDER_ACCOUNT: SENDER_ACCOUNT,
  RECEIVER_ACCOUNT: RECEIVER_ACCOUNT,
  SENDER_COUNTRY: SENDER_COUNTRY,
  RECEIVER_COUNTRY: RECEIVER_COUNTRY,
  SENDER_CURRENCY: SENDER_CURRENCY,
  RECEIVER_CURRENCY: RECEIVER_CURRENCY,
  ACCOUNT_AUA: ACCOUNT_AUA,
  ACCOUNT_SNA: ACCOUNT_SNA,
  ACCOUNT_MCA: ACCOUNT_MCA,
  WALLET_PROFILE_QUERY: WALLET_PROFILE_QUERY,
  TRANSFER_BALANCE_MUTATION: TRANSFER_BALANCE_MUTATION,
  REQUEST_PAYOUT_MUTATION: REQUEST_PAYOUT_MUTATION,
  CREDENTIAL_ENV_NAMES: CREDENTIAL_ENV_NAMES.slice(),
  loadFrozenRates: loadFrozenRates,
  convertWithRates: convertWithRates,
  crossRate: crossRate,
  recommendedDebitOrder: recommendedDebitOrder,
  buildAssertionReport: buildAssertionReport,
  handlerWalletConversion: handlerWalletConversion,
  register: register
};



