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
# Checks only the networks this container runs (MEADOW_NETWORKS), on their relay ports.
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD for n in $(echo "${MEADOW_NETWORKS:-main,beta}" | tr ',' ' '); do \
        case "$n" in main) p="${MEADOW_MAIN_PORT:-8080}" ;; beta) p="${MEADOW_BETA_PORT:-8081}" ;; *) exit 1 ;; esac; \
        wget -qO- "http://127.0.0.1:$p/healthz" >/dev/null || exit 1; \
      done
CMD ["node", "--disable-warning=ExperimentalWarning", "src/main.js"]
