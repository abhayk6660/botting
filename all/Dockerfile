FROM node:20-alpine

# Set working directory inside container
WORKDIR /app

# Copy dependency manifests
COPY package*.json ./

# Install production dependencies
RUN npm install --omit=dev

# Copy application source code
COPY . .

# Expose Render standard port
EXPOSE 10000

# Start bot
CMD ["npm", "start"]
