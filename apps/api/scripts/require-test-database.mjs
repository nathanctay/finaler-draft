if (!process.env.TEST_DATABASE_URL) {
  console.error('TEST_DATABASE_URL is required for persistence integration tests.');
  process.exit(1);
}
