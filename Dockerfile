# Use the official Node.js 20 LTS image
FROM node:20-slim

# Create app directory
WORKDIR /usr/src/app

# Install app dependencies
# Copying package.json AND package-lock.json first ensures better caching
COPY package*.json ./

# Install only production dependencies
RUN npm install --omit=dev

# Bundle app source
COPY . .

# Expose the port your app runs on (change 3000 if your app uses a different port)
EXPOSE 3000

# Start the application
CMD [ "node", "index.js" ]