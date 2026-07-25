/**
 * Local Vite intercepts this route before Vinext. A built bundle has no
 * authority over the host filesystem and therefore advertises no capability.
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
