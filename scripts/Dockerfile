FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /opt/allin
COPY package.json package-lock.json ./
# --ignore-scripts: npm would otherwise run node-gyp on the database module, which fails here
# (no Python or compiler) and isn't needed, because the module loads its shipped binary.
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY build ./build
COPY dist ./dist
RUN groupadd --gid 10001 allin \
 && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin allin \
 && install -d -o allin -g allin -m 0700 /data/vault /data/keys
USER 10001:10001
ENV ALLIN_DATA_DIR=/data/vault ALLIN_KEYSTORE_DIR=/data/keys ALLIN_PORT=4310
VOLUME ["/data/vault", "/data/keys"]
CMD ["node", "build/server/index.js"]
