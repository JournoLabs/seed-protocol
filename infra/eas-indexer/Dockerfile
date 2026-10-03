# The official EAS indexer (github.com/ethereum-attestation-service/eas-indexing-service),
# pinned, with Seed's overlay: one chain config from EAS_CUSTOM_CHAIN. Used by `bun run
# twin:up` (docs/local-twin-plan.md, §9).
#
# Node 20 and a vendored yarn.lock: upstream has no lockfile, and its floating
# dependencies no longer install on its own Node 18 image. To move to a newer upstream,
# bump EAS_INDEXER_REF, delete yarn.lock, build once without --frozen-lockfile, and copy
# /app/yarn.lock back out of the image.
FROM node:20-alpine
ARG EAS_INDEXER_REPO=https://github.com/ethereum-attestation-service/eas-indexing-service.git
ARG EAS_INDEXER_REF=9490bfac2868ace6fb67a517d5dfff3ad71e746a
RUN apk add --no-cache git postgresql-client
RUN git clone "$EAS_INDEXER_REPO" /app && git -C /app checkout --quiet "$EAS_INDEXER_REF"
WORKDIR /app
COPY yarn.lock customChain.ts ./
RUN printf '\nimport { customChainConfigs } from "./customChain";\nEAS_CHAIN_CONFIGS.push(...customChainConfigs);\n' >> chainConfigs.ts
RUN yarn install --frozen-lockfile
RUN chmod +x entrypoint.sh
ENV NODE_ENV=production
EXPOSE 4000
ENTRYPOINT ["/app/entrypoint.sh"]
