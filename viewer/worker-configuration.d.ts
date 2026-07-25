declare namespace Cloudflare {
  interface Env {
    /**
     * Optional because this viewer does not currently provision D1. Hosting can
     * inject the binding later without changing the database helper's API.
     */
    DB?: D1Database;
  }
}
