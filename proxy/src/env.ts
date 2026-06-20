declare global {
  namespace Cloudflare {
    interface Env {
      SESSIONS: DurableObjectNamespace;
      ALLOWED_ORIGINS?: string;
      ALLOWED_BACKENDS?: string;
    }
  }
  type Env = Cloudflare.Env;
}

export {};
