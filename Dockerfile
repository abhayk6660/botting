FROM node:20-alpine

# Set working directory inside container
WORKDIR /app

# Copy package files from the all directory
COPY all/package*.json ./

# Install production dependencies
RUN npm install --omit=dev

# Copy application files from all directory
COPY all/ ./

# Expose standard Render port
EXPOSE 10000

# Start bot
CMD ["npm", "start"]
