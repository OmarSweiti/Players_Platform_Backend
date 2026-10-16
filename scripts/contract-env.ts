// The configuration the contract is generated under (scripts/export-openapi.ts),
// set before the application module loads and validates it. Nothing connects:
// the contract is built in Nest's preview mode (src/contract.ts). Every value
// is fixed, and wins over the shell and over .env, so the contract never
// depends on whose machine generated it. None of them is a secret.
const CONTRACT_ENV = {
  NODE_ENV: 'production',
  API_PREFIX: 'api',
  DATABASE_URL: 'postgresql://127.0.0.1:1/contract',
  REDIS_HOST: '127.0.0.1',
  REDIS_PORT: '1',
  TRUSTED_PROXIES: '',
  CORS_ORIGIN: 'https://app.sadara.test',
  MAIL_FROM: 'no-reply@sadara.test',
  FEATURE_MEDICAL: 'false',
  FEATURE_SCOUTING: 'false',
};

Object.assign(process.env, CONTRACT_ENV);
