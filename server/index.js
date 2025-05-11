const express = require('express');
const axios = require('axios');
const { VisionClient } = require('@google-cloud/vision');
const AWS = require('aws-sdk');
const dotenv = require('dotenv');

// Load environment variables
dotenv.config();

// Initialize Express app
const app = express();
const port = process.env.PORT || 10000;

// Middleware to parse JSON bodies
app.use(express.json({ limit: '10mb' }));

// Initialize Google Cloud Vision client
const client = new VisionClient();

// Initialize AWS S3
const s3 = new AWS.S3({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION,
});

const BUCKET = process.env.BUCKET;

// Placeholder for isValidImage (implement as needed)
async function isValidImage(buffer) {
  // Basic validation (e.g., check buffer size or use image library)
  return buffer && buffer.length > 0;
}

// Placeholder for saveInvalidImage (implement as needed)
async function saveInvalidImage(buffer, id) {
  // Save to S3 or local storage for debugging
  console.log(`Saving invalid image with ID: ${id}`);
}

// Set map for mapping totalCardsInSet to set.id
let setMap = {};

async function fetchSetData() {
  try {
    const response = await axios.get('https://api.pokemontcg.io/v2/sets', {
      headers: { 'X-Api-Key': process.env.POKEMON_TCG_API_KEY },
    });
    const sets = response.data?.data || [];
    setMap = {};
    sets.forEach(set => {
      const total = set.printedTotal || set.total || 0;
      if (total > 0) {
        setMap[total.toString()] = set.id;
      }
    });
  } catch (err) {
    console.error('❌ Failed to fetch set data:', err.message);
    setMap = {
      '203': 'swsh7', // Evolving Skies
      '198': 'swsh9', // Brilliant Stars
      '189': 'swsh10', // Astral Radiance
      '072': 'swsh45', // Shining Fates
      '197': 'sv3', // Obsidian Flames (for Charizard ex)
    };
  }
}
fetchSetData();

async function getCardPrice(cardName, cardNumber, totalCardsInSet) {
  try {
    // Normalize cardNumber by removing leading zeros
    const normalizedCardNumber = cardNumber !== 'Unknown' ? parseInt(cardNumber, 10).toString() : 'Unknown';

    // Log unmapped totalCardsInSet
    if (totalCardsInSet !== 'Unknown' && !setMap[totalCardsInSet]) {
      console.warn(`⚠️ No setMap entry for totalCardsInSet: ${totalCardsInSet}`);
    }

    // Build query without name
    let query = '';
    if (normalizedCardNumber !== 'Unknown') {
      query += `number:${normalizedCardNumber}`;
    }
    if (setMap[totalCardsInSet]) {
      query += (query ? ' ' : '') + `set.id:${setMap[totalCardsInSet]}`;
    }

    // If query is empty, return null to avoid invalid API call
    if (!query) {
      console.warn('⚠️ No valid query parameters provided');
      return {
        name: null,
        number: null,
        setId: null,
        setName: null,
        rarity: null,
        subtypes: null,
        cardmarketPrice: null,
        tcgplayerPrice: null,
        selectedPrice: null,
      };
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

    // Return object with requested fields
    return {
      name: selectedCard?.name || null,
      number: selectedCard?.number || null,
      setId: selectedCard?.set?.id || null,
      setName: selectedCard?.set?.name || null,
      rarity: selectedCard?.rarity || null,
      subtypes: selectedCard?.subtypes || null,
      cardmarketPrice: selectedCard?.cardmarket?.prices?.averageSellPrice || null,
      tcgplayerPrice: selectedCard?.tcgplayer?.prices?.normal?.market || selectedCard?.tcgplayer?.prices?.holofoil?.market || null,
      selectedPrice: price,
    };
  } catch (err) {
    console.error('💸 Price fetch failed:', err.message);
    return {
      name: null,
      number: null,
      setId: null,
      setName: null,
      rarity: null,
      subtypes: null,
      cardmarketPrice: null,
      tcgplayerPrice: null,
      selectedPrice: null,
    };
  }
}

function findPokemonName(text) {
  const lines = text.split('\n');
  // Look for the first line that seems like a Pokémon name (all caps, short, no numbers)
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && /^[A-Z\s-]+$/.test(trimmed) && trimmed.length <= 20 && !/\d/.test(trimmed)) {
      return trimmed;
    }
  }
  return 'Unknown';
}

function findCardNumber(text) {
  const match = text.match(/\d+\/\d+/);
  if (match) {
    const [cardNumber] = match[0].split('/');
    return parseInt(cardNumber, 10).toString(); // e.g., "023" -> "23"
  }
  return 'Unknown';
}

function findTotalCardsInSet(text) {
  const match = text.match(/\d+\/\d+/);
  if (match) {
    const [, total] = match[0].split('/');
    return total; // e.g., "072"
  }
  return 'Unknown';
}

function findEvolutionStage(text) {
  const stages = ['BASIC', 'STAGE 1', 'STAGE 2', 'V', 'VMAX', 'VSTAR', 'EX', 'GX'];
  for (const stage of stages) {
    if (text.toUpperCase().includes(stage)) {
      return stage;
    }
  }
  return 'Unknown';
}

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
    const cardDetails = await getCardPrice(name, cardNumber, totalCardsInSet);

    console.log('🎴 Card Name:', name);
    console.log('🌱 Evolution Stage:', evolution);
    console.log('🔢 Card Number:', cardNumber);
    console.log('📚 Total Cards in Set:', totalCardsInSet);
    console.log('💰 Card Details:', cardDetails);

    const cardData = {
      name: cardDetails.name,
      number: cardDetails.number,
      setId: cardDetails.setId,
      setName: cardDetails.setName,
      rarity: cardDetails.rarity,
      subtypes: cardDetails.subtypes,
      cardmarketPrice: cardDetails.cardmarketPrice,
      tcgplayerPrice: cardDetails.tcgplayerPrice,
      selectedPrice: cardDetails.selectedPrice,
      evolution,
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

// Start the server
app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
});