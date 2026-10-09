# Kasada solver image. Chrome-for-testing is fetched pinned to the current Stable
# linux64 build via the last-known-good-versions feed (same pattern as my other
# solvers); apt chromium would also work but lags Stable and varies by distro.
FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl unzip ca-certificates fonts-liberation xvfb dumb-init \
    libnss3 libnspr4 libdbus-1-3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
    libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 \
    libcairo2 libasound2 libxshmfence1 libx11-xcb1 libxkbcommon0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
RUN set -eux; \
    URL=$(curl -fsSL https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json \
      | grep -o 'https://storage.googleapis.com/chrome-for-testing-public/[^"]*linux64/chrome-linux64.zip' | head -n1); \
    curl -fL -o /tmp/c.zip "$URL"; unzip -q /tmp/c.zip -d /app; mv /app/chrome-linux64 /app/chrome; rm /tmp/c.zip

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.mjs driver.mjs lib.mjs semi-vm-core.mjs targets.mjs ./

ENV CHROME_BIN=/app/chrome/chrome
ENV HIDDEN=1
EXPOSE 8787
ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["xvfb-run", "-a", "--server-args=-screen 0 1280x720x24", "node", "server.mjs"]
