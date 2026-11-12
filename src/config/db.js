const mongoose = require('mongoose');

async function connectDB() {
  const uri = process.env.MONGO_URI;

  if (!uri) {
    throw new Error('MONGO_URI is missing. Copy Backend/.env.example to Backend/.env.');
  }

  mongoose.set('strictQuery', true);

  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 10000,
  });

  console.log(`[db] connected to ${mongoose.connection.host}/${mongoose.connection.name}`);

  return mongoose.connection;
}

module.exports = connectDB;
