# AGENTS.md

## Product Truth

This project is an install-free web app for visualizing network routes.

A browser cannot run exact visitor-device traceroute, MTR, ICMP ping, raw sockets, or TTL-based probes. Do not build or describe the product as if it can.

The correct product model is:

- Browser: UI, animation, target input, realtime display
- Backend: validation, provider integration, streaming
- Measurement provider: nearby distributed probe running traceroute/MTR
- Optional future local agent: exact visitor-device measurement

Always label results honestly as measured from a nearby network probe unless a real local agent exists.

## UX Direction

The app should feel like an emotional network observatory, not a generic admin dashboard.

Use:

- dark atmospheric background
- soft cyan packet glow
- warm coral for warnings
- curved paths
- animated packet movement
- clear hop timeline
- polished empty/loading/error states

Avoid:

- fake claims
- plain dashboard tables as the main experience
- misleading "from your PC" wording
- cluttered technical UI on first view

## Technical Direction

Preferred stack:

- React
- TypeScript
- Vite
- Tailwind CSS
- Framer Motion
- Node.js backend
- Server-Sent Events or WebSocket for realtime updates
- Globalping API as the first measurement provider

Keep provider API keys on the backend only.

## Security Rules

Never pass user input directly into shell commands.

Validate targets strictly as domains or IP addresses.

Reject input with spaces, shell operators, redirects, pipes, semicolons, or unusual characters.

Rate-limit measurement requests.

Add request timeout and cancellation.

Do not expose raw provider errors or server internals to users.

## Copy Rules

Use honest phrases:

- "Measured from a nearby network probe"
- "Install-free browser experience"
- "Not a direct trace from your device"
- "Exact device-level traceroute requires a local agent"

Avoid misleading phrases:

- "Your PC traceroute"
- "Directly from your device"
- "Exact MTR from browser"

## Implementation Priority

First build a beautiful working prototype with:

1. target input
2. Traceout / MTR mode toggle
3. backend measurement endpoint
4. provider integration or mocked provider adapter
5. realtime hop updates
6. animated route visualization
7. clear measurement-source badge
8. README explaining the networking limitations

Prefer understandable code over clever abstractions.
