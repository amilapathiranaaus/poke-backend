const express = require('express');
const cors = require('cors');
const AWS = require('aws-sdk');
const vision = require('@google-cloud/vision');
const dotenv = require('dotenv');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const sharp = require('sharp');

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// AWS S3 setup (v2)
AWS.config.update({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION,
});
const s3 = new AWS.S3();
const BUCKET = process.env.S3_BUCKET_NAME;

// Google Vision setup
const googleCredentials = require('./gcloud-key.json');
const client = new vision.ImageAnnotatorClient({
  credentials: googleCredentials,
});

// Load Pokémon name list
const pokemonNames = fs
  .readFileSync('./pokemon_names.txt', 'utf-8')
  .split('\n')
  .map(name => name.trim().toUpperCase())
  .filter(name => name.length > 0);

// Valid evolution stages
const evolutionStages = ['BASIC', 'STAGE 1', 'STAGE 2', 'V', 'VSTAR', 'VMAX'];

// Dynamic set map with initial fallback
let setMap = {
  '203': 'swsh7', // Evolving Skies
  '198': 'swsh9', // Brilliant Stars
  '189': 'swsh10', // Astral Radiance
  '072': 'swsh45', // Shining Fates
};

// Log initial setMap state
console.log('🛠️ Initial setMap state:', {
  size: Object.keys(setMap).length,
  has072: !!setMap['072']
});

// Fetch set data dynamically
async function fetchSetData() {
  try {
    const response = await axios.get('https://api.pokemontcg.io/v2/sets', {
      headers: {
        'X-Api-Key': process.env.POKEMON_TCG_API_KEY,
      },
    });
    const sets = response.data?.data || [];
    console.log(`🌐 Fetched ${sets.length} sets from Pokémon TCG API`);

    const newSetMap = {};
    sets.forEach(set => {
      const total = set.printedTotal || set.total || 0;
      if (total > 0) {
        newSetMap[total.toString()] = set.id;
      }
    });

    setMap = { ...setMap, ...newSetMap };

    console.log('🗺️ Built setMap:', {
      entryCount: Object.keys(setMap).length,
      totals: Object.keys(setMap).sort((a, b) => a - b),
    });
    console.log('🗺️ Available setMap pairs:', Object.entries(setMap).map(([total, id]) => ({
      setTotal: total,
      setId: id,
      setName: sets.find(set => set.id === id)?.name || 'Unknown'
    })));
    console.log('🛠️ Post-fetch setMap state:', {
      size: Object.keys(setMap).length,
      has072: !!setMap['072']
    });
  } catch (err) {
    console.error('❌ Failed to fetch set data:', err.message);
    console.log('🗺️ Using fallback setMap:', {
      entryCount: Object.keys(setMap).length,
      totals: Object.keys(setMap).sort((a, b) => a - b),
    });
    console.log('🗺️ Available setMap pairs:', Object.entries(setMap).map(([total, id]) => ({
      setTotal: total,
      setId: id,
      setName: ['swsh7', 'swsh9', 'swsh10', 'swsh45'].includes(id)
        ? { swsh7: 'Evolving Skies', swsh9: 'Brilliant Stars', swsh10: 'Astral Radiance', swsh45: 'Shining Fates' }[id]
        : 'Unknown'
    })));
    console.log('🛠️ Post-fallback setMap state:', {
      size: Object.keys(setMap).length,
      has072: !!setMap['072']
    });
  }
}

// Initialize set data on server start
fetchSetData();

// Helper: convert to title case
function toTitleCase(str) {
  return str.toLowerCase().replace(/(^|\s)\w/g, letter => letter.toUpperCase());
}

// Helper: find Pokémon name
function findPokemonName(text) {
  const lines = text.split('\n').map(line => line.trim().toUpperCase());
  for (let line of lines) {
    for (let name of pokemonNames) {
      if (line.includes(name)) {
        return toTitleCase(name); // Return title case, e.g., "Floatzel"
      }
    }
  }
  return 'Unknown';
}

// Helper: find evolution stage
function findEvolutionStage(text) {
  const upperText = text.toUpperCase();
  // Prioritize STAGE 1/STAGE 2 when "Evolves from" is present
  if (upperText.includes('EVOLVES FROM')) {
    if (upperText.includes('STAGE2') || upperText.includes('STAGE 2')) {
      return 'STAGE 2';
    }
    if (upperText.includes('STAGE1') || upperText.includes('STAGE 1') || upperText.includes('STAGE')) {
      return 'STAGE 1';
    }
  }
  // Fallback to other stages
  for (let stage of evolutionStages) {
    if (upperText.includes(stage) && !upperText.includes(`STAGE ${stage}`)) {
      return stage;
    }
  }
  return 'Unknown';
}

// Helper: find card number
function findCardNumber(text) {
  const match = text.match(/\d+\/\d+/);
  if (match) {
    const [cardNumber] = match[0].split('/');
    return cardNumber; // e.g., "23"
  }
  return 'Unknown';
}

// Helper: find total cards in set
function findTotalCardsInSet(text) {
  const match = text.match(/\d+\/\d+/);
  if (match) {
    const [, total] = match[0].split('/');
    return total; // e.g., "72"
  }
  return 'Unknown';
}

// Helper: get card price
async function getCardPrice(cardName, cardNumber, totalCardsInSet) {
  try {
    // Normalize cardNumber by removing leading zeros
    const normalizedCardNumber = cardNumber !== 'Unknown' ? parseInt(cardNumber, 10).toString() : 'Unknown';

    // Log unmapped totalCardsInSet
    if (totalCardsInSet !== 'Unknown' && !setMap[totalCardsInSet]) {
      console.warn(`⚠️ No setMap entry for totalCardsInSet: ${totalCardsInSet}`);
    }

    // Build specific query
    let query = `name:${encodeURIComponent(cardName)}`;
    if (normalizedCardNumber !== 'Unknown') {
      query += ` number:${normalizedCardNumber}`;
    }
    if (setMap[totalCardsInSet]) {
      query += ` set.id:${setMap[totalCardsInSet]}`;
    }

    console.log('🔍 Constructed query:', query);

    const response = await axios.get(`https://api.pokemontcg.io/v2/cards?q=${query}`, {
      headers: {
        'X-Api-Key': process.env.POKEMON_TCG_API_KEY,
      },
    });

    const cards = response.data?.data || [];
    console.log('🔎 TCG API Response (specific query):', {
      query,
      cardCount: cards.length,
      cards: cards.map(card => ({
        name: card.name,
        number: card.number,
        setId: card.set.id,
        setName: card.set.name,
        setTotal: card.set.total || card.set.printedTotal,
        rarity: card.rarity,
        subtypes: card.subtypes,
        cardmarketPrice: card.cardmarket?.prices?.averageSellPrice || null,
        tcgplayerPrice: card.tcgplayer?.prices?.normal?.market || card.tcgplayer?.prices?.holofoil?.market || null,
      })),
    });

    // Select the first card or null if no cards are found
    const selectedCard = cards[0] || null;

    const price = selectedCard?.cardmarket?.prices?.averageSellPrice ||
                  selectedCard?.tcgplayer?.prices?.normal?.market ||
                  selectedCard?.tcgplayer?.prices?.holofoil?.market || null;

    console.log('💰 Selected card:', {
      name: selectedCard?.name,
      number: selectedCard?.number,
      setId: selectedCard?.set?.id,
      setName: selectedCard?.set?.name,
      rarity: selectedCard?.rarity,
      subtypes: selectedCard?.subtypes,
      cardmarketPrice: selectedCard?.cardmarket?.prices?.averageSellPrice || null,
      tcgplayerPrice: selectedCard?.tcgplayer?.prices?.normal?.market || selectedCard?.tcgplayer?.prices?.holofoil?.market || null,
      selectedPrice: price,
    });

    return price;
  } catch (err) {
    console.error('💸 Price fetch failed:', err.message);
    return null;
  }
}

function findCardNumber(text) {
  const match = text.match(/\d+\/\d+/);
  if (match) {
    const [cardNumber] = match[0].split('/');
    return parseInt(cardNumber, 10).toString(); // e.g., "023" -> "23"
  }
  return 'Unknown';
}

// Helper: validate image buffer
async function isValidImage(buffer) {
  try {
    // Check file signature for JPEG
    if (!buffer.slice(0, 2).equals(Buffer.from([0xff, 0xd8]))) {
      console.error('🖼️ Invalid JPEG signature');
      return false;
    }
    // Attempt to read metadata
    await sharp(buffer).metadata();
    return true;
  } catch (err) {
    console.error('🖼️ Invalid image buffer:', err.message);
    return false;
  }
}

// Helper: save invalid image to S3 for debugging
async function saveInvalidImage(buffer, id) {
  try {
    await s3
      .putObject({
        Bucket: BUCKET,
        Key: `invalid-images/${id}.jpg`,
        Body: buffer,
        ContentType: 'image/jpeg',
      })
      .promise();
    console.log(`🖼️ Saved invalid image to S3: invalid-images/${id}.jpg`);
  } catch (err) {
    console.error('❌ Failed to save invalid image:', err.message);
  }
}

// POST /process-card
app.post('/process-card', async (req, res) => {
  try {
    // Validate base64 input
    if (!req.body.imageBase64 || !req.body.imageBase64.includes(',')) {
      return res.status(400).json({ error: 'Invalid base64 image' });
    }

    const base64 = req.body.imageBase64.split(',')[1];
    const buffer = Buffer.from(base64, 'base64');
    const id = `pokemon-${Date.now()}`;

    // Validate image
    if (!(await isValidImage(buffer))) {
      await saveInvalidImage(buffer, id);
      return res.status(400).json({ error: 'Invalid or corrupted image' });
    }

    const imageKey = `${id}.jpg`;
    const metadataKey = `${id}.json`;

    // Upload original image to S3
    await s3
      .putObject({
        Bucket: BUCKET,
        Key: imageKey,
        Body: buffer,
        ContentType: 'image/jpeg',
      })
      .promise();

    const imageUrl = `https://${BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/${imageKey}`;

    // OCR on original image
    const [result] = await client.textDetection({ image: { content: buffer } });
    const text = result.textAnnotations[0]?.description || 'No text found';
    console.log('🔍 Full OCR text:\n', text);

    const name = findPokemonName(text);
    const evolution = findEvolutionStage(text);
    const cardNumber = findCardNumber(text);
    const totalCardsInSet = findTotalCardsInSet(text);
    const price = await getCardPrice(name, cardNumber, totalCardsInSet);

    console.log('🎴 Card Name:', name);
    console.log('🌱 Evolution Stage:', evolution);
    console.log('🔢 Card Number:', cardNumber);
    console.log('📚 Total Cards in Set:', totalCardsInSet);
    console.log('💰 Price:', price);

    const cardData = {
      name,
      evolution,
      cardNumber,
      totalCardsInSet,
      price,
      fullText: text,
      imageUrl,
    };

    await s3
      .putObject({
        Bucket: BUCKET,
        Key: metadataKey,
        Body: JSON.stringify(cardData),
        ContentType: 'application/json',
      })
      .promise();

    res.json(cardData);
  } catch (err) {
    console.error('❌ Error:', err.message);
    res.status(500).json({ error: 'Processing failed' });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`✅ Server running on http://localhost:${PORT}`));