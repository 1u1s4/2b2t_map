/**
 * The deployed site cannot read the user's disk. During local development,
 * Vite intercepts this route only when OBSIDIAN_ATLAS_PROGRESS_FILE is set.
 */
export async function GET() {
  return new Response(null, {
    status: 204,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
