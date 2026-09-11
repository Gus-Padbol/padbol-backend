// Local integration only. These are server-owned switches, never request/body flags.
// Writer stays OFF pending review/application of private SQL and production-scope integration checks.
// Reader may be enabled separately after the private migration and scope checks are verified.
export const MANUAL_PLAYED_DATE_CAPABILITY = Object.freeze({ writeEnabled: false, readEnabled: false });
