FROM node:24-alpine

WORKDIR /app

# Install production dependencies first for layer caching
COPY portal/package*.json ./portal/
RUN cd portal && npm ci --omit=dev && npm cache clean --force

# Copy lab catalog, captured product screenshots, slot overlay metadata, and portal app
COPY labs/ ./labs/
COPY docs/feature-tour/screenshots/ ./docs/feature-tour/screenshots/
COPY tools/feature-tour/overlay.json ./tools/feature-tour/overlay.json
COPY portal/ ./portal/
COPY README.md ./
COPY template.config.json ./

# Ensure runtime writable directories exist for non-root execution (Azure Blob mirror root + optional volume mounts)
RUN mkdir -p /app/portal-storage/generated-labs /app/portal-storage/data/lab-builder /app/portal-storage/uploads \
    /mnt/portal-storage/generated-labs /mnt/portal-storage/data/lab-builder /mnt/portal-storage/uploads \
    /app/generated-labs /app/portal/data/lab-builder /app/portal/public/uploads \
  && chown -R node:node /app/portal-storage /mnt/portal-storage /app/generated-labs /app/portal/data /app/portal/public/uploads

WORKDIR /app/portal

ENV NODE_ENV=production
ENV PORT=3005
ENV HOST=0.0.0.0

EXPOSE 3005

USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3005) + '/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "server.js"]
