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

// AWS S3 setup
AWS.config.update({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION,
});
const s3 = new AWS.S3();
const BUCKET = process.env.S3_BUCKET_NAME;

// Google Vision API setup
const googleCredentials = require('./gcloud-key.json');
const client = new vision.ImageAnnotatorClient({ credentials: googleCredentials });

// Load Pokémon name list
const pokemonNames = fs
  .readFileSync('./pokemon_names.txt', 'utf-8')
  .split('\n')
  .map(name => name.trim().toUpperCase())
  .filter(name => name.length > 0);

// Evolution stages
const evolutionStages = ['BASIC', 'STAGE 1', 'STAGE 2', 'V', 'VSTAR', 'VMAX'];

// Set map
let setMap = {
  '203': 'swsh7',
  '198': 'swsh9',
  '189': 'swsh10',
  '072': 'swsh45',
};

async function fetchSetData() {
  try {
    const response = await axios.get('https://api.pokemontcg.io/v2/sets', {
      headers: { 'X-Api-Key': process.env.POKEMON_TCG_API_KEY },
    });
    const sets = response.data?.data || [];

    const newSetMap = {};
    sets.forEach(set => {
      const total = set.printedTotal || set.total || 0;
      if (total > 0) {
        newSetMap[total.toString()] = set.id;
      }
    });

    setMap = { ...setMap, ...newSetMap };
    console.log(`✅ Loaded ${Object.keys(setMap).length} set mappings`);
  } catch (err) {
    console.error('⚠️ Failed to fetch set data:', err.message);
  }
}
fetchSetData();

// Helpers
function toTitleCase(str) {
  return str.toLowerCase().replace(/(^|\s)\w/g, letter => letter.toUpperCase());
}

function findPokemonName(text) {
  const lines = text.split('\n').map(line => line.trim().toUpperCase());
  for (const line of lines) {
    for (const name of pokemonNames) {
      if (line.includes(name)) {
        return toTitleCase(name);
      }
    }
  }
  return 'Unknown';
}

function findEvolutionStage(text) {
  const upperText = text.toUpperCase();
  if (upperText.includes('EVOLVES FROM')) {
    if (upperText.includes('STAGE2') || upperText.includes('STAGE 2')) return 'STAGE 2';
    if (upperText.includes('STAGE1') || upperText.includes('STAGE 1') || upperText.includes('STAGE')) return 'STAGE 1';
  }
  for (const stage of evolutionStages) {
    if (upperText.includes(stage)) return stage;
  }
  return 'Unknown';
}

function extractCardInfo(text) {
  const promoPrefixToSetId = {
    SWSH: 'swshp',
    SM: 'smp',
    XY: 'xyp',
    BW: 'bwp',
    DP: 'dpp',
    HGSS: 'hgssp',
  };

  text = text.toUpperCase();

  const normalMatch = text.match(/\b(\d{1,3})\/(\d{1,3})\b/);
  if (normalMatch) {
    let cardNumber = normalMatch[1].replace(/^0+/, ''); // 🧹 REMOVE LEADING ZEROS
    const totalCards = normalMatch[2];
    return { cardNumber, totalCardsInSet: totalCards, setId: null };
  }

  const promoMatch = text.match(/\b(SWSH|SM|XY|BW|DP|HGSS)(\d{1,4})\b/);
  if (promoMatch) {
    const prefix = promoMatch[1];
    const number = promoMatch[1] + promoMatch[2];
    const setId = promoPrefixToSetId[prefix] || null;
    return { cardNumber: number, totalCardsInSet: null, setId };
  }

  return { cardNumber: null, totalCardsInSet: null, setId: null };
}

async function getCardPrice(cardNumber, totalCardsInSet, overrideSetId = null) {
  try {
    let query = '';

    if (cardNumber) {
      query += `number:${cardNumber}`;
    }

    if (overrideSetId) {
      if (query) query += ' ';
      query += `set.id:${overrideSetId}`;
    } else if (setMap[totalCardsInSet]) {
      if (query) query += ' ';
      query += `set.id:${setMap[totalCardsInSet]}`;
    }

    console.log('🔍 Query:', query);

    const response = await axios.get(`https://api.pokemontcg.io/v2/cards?q=${query}`, {
      headers: { 'X-Api-Key': process.env.POKEMON_TCG_API_KEY },
    });

    const cards = response.data?.data || [];
    console.log('📦 API Response Cards:', JSON.stringify(cards, null, 2));

    const selectedCard = cards[0] || null;

    const price = selectedCard?.cardmarket?.prices?.averageSellPrice ||
                  selectedCard?.tcgplayer?.prices?.normal?.market ||
                  selectedCard?.tcgplayer?.prices?.holofoil?.market || null;

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

async function isValidImage(buffer) {
  try {
    if (!buffer.slice(0, 2).equals(Buffer.from([0xff, 0xd8]))) {
      console.error('🖼️ Invalid JPEG signature');
      return false;
    }
    await sharp(buffer).metadata();
    return true;
  } catch (err) {
    console.error('🖼️ Image validation failed:', err.message);
    return false;
  }
}

async function saveInvalidImage(buffer, id) {
  try {
    await s3.putObject({
      Bucket: BUCKET,
      Key: `invalid-images/${id}.jpg`,
      Body: buffer,
      ContentType: 'image/jpeg',
    }).promise();
    console.log(`🖼️ Saved invalid image: invalid-images/${id}.jpg`);
  } catch (err) {
    console.error('❌ Failed to save invalid image:', err.message);
  }
}

// API Route
app.post('/process-card', async (req, res) => {
  try {
    const { imageBase64 } = req.body;
    if (!imageBase64 || !imageBase64.includes(',')) {
      return res.status(400).json({ error: 'Invalid base64 image' });
    }

    const base64Data = imageBase64.split(',')[1];
    const buffer = Buffer.from(base64Data, 'base64');
    const id = `pokemon-${Date.now()}`;

    if (!(await isValidImage(buffer))) {
      await saveInvalidImage(buffer, id);
      return res.status(400).json({ error: 'Invalid or corrupted image' });
    }

    const imageKey = `${id}.jpg`;
    const metadataKey = `${id}.json`;

    await s3.putObject({
      Bucket: BUCKET,
      Key: imageKey,
      Body: buffer,
      ContentType: 'image/jpeg',
    }).promise();

    const imageUrl = `https://${BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/${imageKey}`;

    const [result] = await client.textDetection({ image: { content: buffer } });
    const text = result.textAnnotations[0]?.description || 'No text found';

    console.log('📝 OCR text:\n', text);

    const name = findPokemonName(text);
    const evolution = findEvolutionStage(text);
    const { cardNumber, totalCardsInSet, setId: overrideSetId } = extractCardInfo(text);
    const cardDetails = await getCardPrice(cardNumber, totalCardsInSet, overrideSetId);
    console.log(`📛 Set ID used: ${cardDetails.setId}`);

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

    await s3.putObject({
      Bucket: BUCKET,
      Key: metadataKey,
      Body: JSON.stringify(cardData),
      ContentType: 'application/json',
    }).promise();

    res.json(cardData);
  } catch (err) {
    console.error('❌ Processing failed:', err.message);
    res.status(500).json({ error: 'Processing failed' });
  }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
