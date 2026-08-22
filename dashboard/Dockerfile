# syntax=docker/dockerfile:1
FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN mkdir -p /app/public
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
# The auth cookie name must be pinned at BUILD time, not runtime. Next.js
# inlines only NEXT_PUBLIC_* into the client bundle, so a value supplied to the
# container at runtime is visible to SSR and the proxy but invisible to the
# browser — the two halves would then look for different cookies and every
# signed-in user would be redirected to /login. Passing it as a build arg is
# what makes "pinned rather than derived" true on both sides.
ARG NEXT_PUBLIC_SUPABASE_AUTH_COOKIE_NAME
ARG BUILD_SHA=unknown
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL
ENV NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY
ENV NEXT_PUBLIC_SUPABASE_AUTH_COOKIE_NAME=$NEXT_PUBLIC_SUPABASE_AUTH_COOKIE_NAME
ENV BUILD_SHA=$BUILD_SHA
ENV NEXT_TELEMETRY_DISABLED=1
RUN node -e 'for (const name of ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY"]) { if (!process.env[name]) { throw new Error(`${name} is required`) } }' \
    && npm run build

FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
# Also carried into the runner so SSR and the proxy read the SAME pinned value
# at runtime that the browser bundle had inlined at build time. If only the
# builder stage set it, the two halves could still disagree.
ARG NEXT_PUBLIC_SUPABASE_AUTH_COOKIE_NAME
ENV NEXT_PUBLIC_SUPABASE_AUTH_COOKIE_NAME=$NEXT_PUBLIC_SUPABASE_AUTH_COOKIE_NAME
ARG BUILD_SHA=unknown
ENV BUILD_SHA=$BUILD_SHA
LABEL org.opencontainers.image.revision=$BUILD_SHA
RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001
# NO PACKAGE MANAGER IN A FROZEN ARTIFACT.
#
# A Next standalone server runs `node server.js`; no package manager is invoked
# at runtime. The base image nonetheless ships several — npm and npx, yarn and
# yarnpkg (/opt/yarn-v*), and corepack — and npm's own bundled dependency tree
# is where EVERY vulnerability in this image came from. Measured on the sealed
# artifact at 3eb8f0ad: 1 CRITICAL, 7 HIGH and 8 MEDIUM, all sixteen under
# usr/local/lib/node_modules/npm/node_modules/ (tar, brace-expansion,
# ip-address, picomatch, sigstore), and not one of them an application
# dependency. Bumping this project's lockfile would have fixed none of them.
#
# Removing npm alone is not enough and is not what the header claims: corepack
# exists specifically to fetch and activate npm/pnpm/yarn from the network, so
# a lone `corepack enable` would put a package manager back. So every manager
# and every shim goes, and the build then FAILS if any of them is still on PATH
# — a base image that relocates or reintroduces one fails here instead of
# silently shipping it again. (dockerfile-package-manager.test.ts pins this.)
# Removing them is also the right shape independently of any CVE: a container
# whose entire purpose is that it cannot change should not carry the tools for
# changing it.
RUN rm -rf \
      /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
      /usr/local/lib/node_modules/corepack /usr/local/bin/corepack \
      /opt/yarn-v* /usr/local/bin/yarn /usr/local/bin/yarnpkg \
 && for pm in npm npx yarn yarnpkg corepack pnpm pnpx; do \
      if command -v "$pm" >/dev/null 2>&1; then \
        echo "FROZEN ARTIFACT: package manager '$pm' survived removal at $(command -v "$pm")" >&2; \
        exit 1; \
      fi; \
    done
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
USER nextjs
EXPOSE 3000
CMD ["node", "server.js"]
