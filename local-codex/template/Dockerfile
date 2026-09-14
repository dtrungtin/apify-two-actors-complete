# Generated Actor image. Based on the official Apify Node.js image.
FROM apify/actor-node:22

# Install production dependencies first so this layer is cached between builds.
COPY package*.json ./
RUN npm --quiet set progress=false \
    && npm install --omit=dev --omit=optional \
    && echo "Installed NPM packages:" \
    && (npm list --omit=dev --all || true) \
    && echo "Node.js version:" \
    && node --version \
    && echo "NPM version:" \
    && npm --version

# Copy the rest of the source code.
COPY . ./

CMD npm start --silent
