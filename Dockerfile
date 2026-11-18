# Debian (glibc) base: @snazzah/davey ships glibc prebuilt binaries, so no Alpine.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# The bot serves no HTTP, so nothing is exposed.
# Recordings are written under /app/recordings, so the node user must own that folder.
RUN mkdir -p /app/recordings && chown node:node /app/recordings
USER node
CMD ["node", "dist/index.js"]
