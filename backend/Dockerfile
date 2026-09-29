# Meadow node. Zero dependencies: Node's built-in HTTP, crypto, and SQLite.
# One process runs a separate node per network (MainNet relay port 8080,
# Beta 8081; peer ports 8090 and 8091).
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production MEADOW_DATA_DIR=/data
COPY package.json ./
COPY src ./src
RUN mkdir -p /data && chown -R node:node /data /app
VOLUME ["/data"]
EXPOSE 8080 8081 8090 8091
USER node
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null && wget -qO- http://127.0.0.1:8081/healthz >/dev/null || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "src/main.js"]
