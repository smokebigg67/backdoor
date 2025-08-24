const Auction = require('../models/auctionModel');
const Bid = require('../models/bidModel');
const User = require('../models/userModel');
const web3Service = require('../services/web3Service');
const { socketService } = require('../services/socketService');
const logger = require('../utils/logger');

// Get all auctions with filters
const getAuctions = async (req, res) => {
  try {
    const {
      type,
      status = 'active',
      category,
      page = 1,
      limit = 20,
      sort = 'newest',
      search,
      price_min,
      price_max
    } = req.query;

    const query = {};
    
    if (type) query.type = type;
    if (status) query.status = status;
    if (category) query.category = category;
    
    if (price_min || price_max) {
      query['pricing.currentBid'] = {};
      if (price_min) query['pricing.currentBid'].$gte = parseFloat(price_min);
      if (price_max) query['pricing.currentBid'].$lte = parseFloat(price_max);
    }

    if (search) {
      query.$or = [
        { title: { $regex: search, $options: 'i' } },
        { description: { $regex: search, $options: 'i' } }
      ];
    }

    if (!req.user || !req.user.roles.includes('moderator')) {
      query['moderation.isApproved'] = true;
    }

    let sortQuery = {};
    switch (sort) {
      case 'newest': sortQuery = { createdAt: -1 }; break;
      case 'ending_soon': sortQuery = { 'timing.endTime': 1 }; break;
      case 'price_high': sortQuery = { 'pricing.currentBid': -1 }; break;
      default: sortQuery = { createdAt: -1 };
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [auctions, total] = await Promise.all([
      Auction.find(query)
        .sort(sortQuery)
        .skip(skip)
        .limit(parseInt(limit))
        .populate('seller.userId', 'anonymousId profile.reputation'),
      Auction.countDocuments(query)
    ]);

    res.json({
      success: true,
      message: 'Auctions retrieved successfully',
      data: {
        auctions,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          pages: Math.ceil(total / parseInt(limit))
        }
      }
    });
  } catch (error) {
    logger.error('Get auctions error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to retrieve auctions',
      data: null
    });
  }
};

module.exports = {
  getAuctions
};