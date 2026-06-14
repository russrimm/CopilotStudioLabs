FROM node:20-alpine

WORKDIR /app

# Copy portal and lab content
COPY portal/package*.json ./portal/
RUN cd portal && npm ci --omit=dev

COPY labs/ ./labs/
COPY portal/ ./portal/
COPY README.md ./
COPY template.config.json ./

WORKDIR /app/portal

EXPOSE 3000

ENV NODE_ENV=production
ENV PORT=3000

CMD ["node", "server.js"]
