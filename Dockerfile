# The web UI, containerised so that `docker compose up` gives a database and a
# page to read it with.
#
# Nothing else in this repository is containerised, and that is still the right
# default: the CLI and the eval suite run on the host under tsx, where they can
# see your .env and your AWS profile. What earns a container here is that a UI is
# the one part somebody wants running continuously without a terminal open.
#
# ── Why devDependencies are installed ──
#
# Nothing in this repository is built. tsconfig.json sets noEmit and tsx runs the
# TypeScript directly, deliberately — a dist/ would be a second copy of the source
# that can silently disagree with it. tsx is therefore the RUNTIME, and it is a
# devDependency, so `npm ci --omit=dev` produces an image that cannot start.
#
# NODE_ENV is not set to production for the same reason: it would be the
# misleading half of the truth about what is installed here.
FROM node:24-alpine

WORKDIR /app

# The manifest and the lockfile first, so editing a file in src/ does not
# reinstall node_modules. `ci` rather than `install`: it installs exactly the
# lockfile and fails if the two have drifted, which is the difference between
# building what will be installed and building whatever resolved today.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# The source, and the tsconfig it is typechecked against. Copied after the
# install so a code change reuses the layer above.
COPY tsconfig.json ./
COPY src ./src

# The base image ships an unprivileged `node` user. Nothing here writes to disk,
# so root would only be a larger blast radius for no benefit.
USER node

# ── WEB_BIND is 0.0.0.0 IN HERE, and that is not a contradiction ──
#
# The server defaults to 127.0.0.1 because a process on a laptop that binds
# 0.0.0.0 publishes its approve buttons to the café network. Inside a container,
# 127.0.0.1 means the container's own loopback: bind there and the published port
# reaches nothing, because the packets arrive on the container's eth0. The
# isolation boundary has moved from the interface to the port publication.
#
# So the container binds every interface it has — which is one, on a private
# network — and docker-compose.yml publishes it as `127.0.0.1:3000:3000` so the
# host is where "local only" is enforced.
#
# If you run this image by hand, publish it the same way. `docker run -p
# 3000:3000` binds every interface of the HOST, which is the thing the default was
# avoiding.
ENV WEB_BIND=0.0.0.0
ENV PORT=3000
EXPOSE 3000

# No HEALTHCHECK, deliberately. `docker compose up --wait` waits for every service
# that has one, and `npm run db:up` is that command — a healthcheck here would
# make bringing up the database also wait on the UI answering a request. The thing
# worth waiting for is the schema and the seed, and the db service already checks
# for those over TCP.

# npx tsx, not `npm run web`: this image must not depend on a script that may or
# may not be in package.json yet. No --env-file either — the environment comes
# from compose, and a container that silently read a .env baked into an image
# would be a second source of truth about which database it is talking to.
CMD ["npx", "tsx", "src/web/server.ts"]
