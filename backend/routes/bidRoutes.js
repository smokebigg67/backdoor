const express = require('express');
const { body, query, param, validationResult } = require('express-validator');
const Bid = require('../models/bidModel');
const Auction = require('../models/auctionModel');
const User = require('../models/userModel');
const TokenTransaction = require('../models/tokenTransactionModel');
const { auth, optionalAuth } = require('../middleware/auth');
const { asyncHandler, formatValidationErrors, NotFoundError, ValidationError } = require('../middleware/errorHandler');
const web3Service = require('../services/web3Service');
const { socketService } = require('../services/socketService');
const logger = require('../utils/logger');

const router = express.Router();

// @route   GET /api/v1/bids/my-bids
// @desc    Get user's bid history
// @access  Private
router.get('/my-bids', [
  auth,
  query('status').optional().isIn(['pending', 'active', 'outbid', 'winning', 'won', 'lost', 'cancelled', 'refunded']),
  query('page').optional().isInt({ min: 1 }),
  query('limit').optional().isInt({ min: 1, max: 100 })
], asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      message: 'Validation errors',
      errors: formatValidationErrors(errors)
    });
  }

  const { status, page = 1, limit = 20 } = req.query;
  const skip = (parseInt(page) - 1) * parseInt(limit);

  const query = { 'bidder.userId': req.user.userId };
  if (status) query.status = status;

  const [bids, total] = await Promise.all([
    Bid.find(query)
      .populate('auction.auctionRef', 'title status timing.endTime pricing.currentBid')
      .sort({ 'timing.placedAt': -1 })
      .skip(skip)
      .limit(parseInt(limit)),
    Bid.countDocuments(query)
  ]);

  logger.api('/bids/my-bids', 'GET', 200, { 
    userId: req.user.userId,
    resultCount: bids.length 
  });

  res.json({
    success: true,
    message: 'Bid history retrieved successfully',
    data: {
      bids,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      }
    }
  });
}));

// @route   POST /api/v1/auctions/:id/bids
// @desc    Place new bid
// @access  Private
router.post('/:auctionId/bids', [
  auth,
  param('auctionId').isMongoId().withMessage('Invalid auction ID'),
  body('amount').isFloat({ min: 0.01 }).withMessage('Bid amount must be greater than 0'),
  body('isAutoBid').optional().isBoolean(),
  body('maxAmount').optional().isFloat({ min: 0 }),
  body('increment').optional().isFloat({ min: 0 })
], asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      message: 'Validation errors',
      errors: formatValidationErrors(errors)
    });
  }

  const { amount, isAutoBid = false, maxAmount, increment } = req.body;
  const auctionId = req.params.auctionId;

  // Find auction
  const auction = await Auction.findById(auctionId);
  if (!auction) {
    throw new NotFoundError('Auction not found');
  }

  // Check if auction is active
  if (auction.status !== 'active') {
    return res.status(400).json({
      success: false,
      message: 'Auction is not active',
      data: null
    });
  }

  // Check if auction has ended
  if (new Date() >= auction.timing.endTime) {
    return res.status(400).json({
      success: false,
      message: 'Auction has ended',
      data: null
    });
  }

  // Check if user is not the seller
  if (auction.seller.userId.toString() === req.user.userId) {
    return res.status(400).json({
      success: false,
      message: 'Cannot bid on your own auction',
      data: null
    });
  }

  // Validate bid amount
  const minBidAmount = auction.pricing.currentBid + auction.bidding.bidIncrement;
  if (amount < minBidAmount) {
    return res.status(400).json({
      success: false,
      message: `Bid must be at least ${minBidAmount} tokens`,
      data: null
    });
  }

  // Check user's token balance
  const userBalance = await web3Service.getTokenBalance(req.user.walletAddress);
  if (parseFloat(userBalance) < amount) {
    return res.status(400).json({
      success: false,
      message: 'Insufficient token balance',
      data: null
    });
  }

  // Create bid
  const bid = new Bid({
    auction: {
      auctionId: auction.auctionId,
      auctionRef: auction._id
    },
    bidder: {
      userId: req.user.userId,
      anonymousId: req.user.anonymousId,
      walletAddress: req.user.walletAddress
    },
    amount,
    autoBid: {
      isAutoBid,
      maxAmount,
      increment,
      isActive: isAutoBid
    },
    metadata: {
      ipAddress: req.ip,
      userAgent: req.get('User-Agent'),
      bidSource: 'web'
    }
  });

  await bid.save();

  try {
    // Lock tokens on blockchain
    const lockResult = await web3Service.placeBidOnChain(
      auction.auctionId,
      amount
    );

    // Update bid with blockchain info
    bid.blockchain.transactionHash = lockResult.transactionHash;
    bid.blockchain.blockNumber = lockResult.blockNumber;
    bid.blockchain.isOnChain = true;
    bid.status = 'pending'; // Will be updated to 'active' by blockchain event
    await bid.save();

    // Mark previous highest bidder as outbid
    if (auction.bidding.highestBidder.userId) {
      await Bid.updateMany(
        {
          'auction.auctionRef': auction._id,
          'bidder.userId': auction.bidding.highestBidder.userId,
          status: 'winning'
        },
        { status: 'outbid' }
      );
    }

    // Update auction with new highest bid
    await auction.placeBid(amount, {
      userId: req.user.userId,
      anonymousId: req.user.anonymousId,
      walletAddress: req.user.walletAddress
    });

    // Mark current bid as winning
    bid.status = 'winning';
    await bid.save();

    // Create token transaction record
    const tokenTransaction = new TokenTransaction({
      type: 'bid_lock',
      user: {
        userId: req.user.userId,
        walletAddress: req.user.walletAddress,
        anonymousId: req.user.anonymousId
      },
      amount,
      blockchain: {
        transactionHash: lockResult.transactionHash,
        blockNumber: lockResult.blockNumber,
        gasUsed: lockResult.gasUsed
      },
      relatedTo: {
        type: 'bid',
        id: bid.bidId,
        reference: bid._id
      },
      status: 'pending'
    });

    await tokenTransaction.save();

    // Broadcast bid update via WebSocket
    if (socketService) {
      socketService.broadcastBidUpdate(auction.auctionId, {
        bidId: bid.bidId,
        bidder: bid.bidder.anonymousId,
        amount: bid.amount,
        isNewHighest: true
      });
    }

    logger.auction('bid_placed', auction.auctionId, {
      bidId: bid.bidId,
      userId: req.user.userId,
      amount,
      transactionHash: lockResult.transactionHash
    });

    res.status(201).json({
      success: true,
      message: 'Bid submitted to blockchain - awaiting confirmation',
      data: {
        bid: {
          id: bid._id,
          bidId: bid.bidId,
          amount: bid.amount,
          status: bid.status,
          placedAt: bid.timing.placedAt,
          transactionHash: lockResult.transactionHash
        }
      }
    });

  } catch (blockchainError) {
    // If blockchain transaction fails, mark bid as failed
    bid.status = 'cancelled';
    bid.validation.isValid = false;
    bid.validation.validationErrors.push('Blockchain transaction failed');
    await bid.save();

    logger.error('Blockchain bid placement failed:', blockchainError);
    
    res.status(400).json({
      success: false,
      message: 'Failed to submit bid to blockchain',
      data: null
    });
  }
}));

// @route   GET /api/v1/auctions/:id/bids
// @desc    Get all bids for auction (anonymized)
// @access  Public
router.get('/:auctionId/bids', [
  param('auctionId').isMongoId().withMessage('Invalid auction ID'),
  query('page').optional().isInt({ min: 1 }),
  query('limit').optional().isInt({ min: 1, max: 100 })
], optionalAuth, asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      message: 'Validation errors',
      errors: formatValidationErrors(errors)
    });
  }

  const { page = 1, limit = 50 } = req.query;
  const skip = (parseInt(page) - 1) * parseInt(limit);

  // Find auction
  const auction = await Auction.findById(req.params.auctionId);
  if (!auction) {
    throw new NotFoundError('Auction not found');
  }

  // Get bids (anonymized for public view)
  const bids = await Bid.find({ 'auction.auctionRef': auction._id })
    .sort({ amount: -1, 'timing.placedAt': -1 })
    .skip(skip)
    .limit(parseInt(limit))
    .select('bidId amount timing.placedAt status bidder.anonymousId');

  const total = await Bid.countDocuments({ 'auction.auctionRef': auction._id });

  res.json({
    success: true,
    message: 'Auction bids retrieved successfully',
    data: {
      bids,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      }
    }
  });
}));

// @route   DELETE /api/v1/bids/:id
// @desc    Withdraw bid (if allowed)
// @access  Private
router.delete('/:bidId', [
  auth,
  param('bidId').isString().withMessage('Invalid bid ID')
], asyncHandler(async (req, res) => {
  const bid = await Bid.findOne({ bidId: req.params.bidId });
  
  if (!bid) {
    throw new NotFoundError('Bid not found');
  }

  // Check ownership
  if (bid.bidder.userId.toString() !== req.user.userId) {
    return res.status(403).json({
      success: false,
      message: 'Access denied - not bid owner',
      data: null
    });
  }

  // Check if bid can be withdrawn
  if (bid.status !== 'active' && bid.status !== 'outbid') {
    return res.status(400).json({
      success: false,
      message: 'Cannot withdraw this bid',
      data: null
    });
  }

  // Get auction to check timing
  const auction = await Auction.findById(bid.auction.auctionRef);
  const timeRemaining = auction.timing.endTime - new Date();
  
  // Don't allow withdrawal in last 5 minutes
  if (timeRemaining < 5 * 60 * 1000) {
    return res.status(400).json({
      success: false,
      message: 'Cannot withdraw bid in the last 5 minutes',
      data: null
    });
  }

  try {
    // Unlock tokens on blockchain
    const unlockResult = await web3Service.transferTokens(
      req.user.walletAddress,
      bid.amount
    );

    // Update bid status
    bid.status = 'cancelled';
    bid.timing.refundedAt = new Date();
    bid.refund.isRefunded = true;
    bid.refund.refundAmount = bid.amount;
    bid.refund.refundTransactionHash = unlockResult.transactionHash;
    bid.refund.refundReason = 'User withdrawal';
    await bid.save();

    // Create refund transaction record
    const refundTransaction = new TokenTransaction({
      type: 'bid_unlock',
      user: {
        userId: req.user.userId,
        walletAddress: req.user.walletAddress,
        anonymousId: req.user.anonymousId
      },
      amount: bid.amount,
      blockchain: {
        transactionHash: unlockResult.transactionHash,
        blockNumber: unlockResult.blockNumber,
        gasUsed: unlockResult.gasUsed,
        isConfirmed: true
      },
      relatedTo: {
        type: 'bid',
        id: bid.bidId,
        reference: bid._id
      },
      status: 'confirmed'
    });

    await refundTransaction.save();

    logger.auction('bid_withdrawn', auction.auctionId, {
      bidId: bid.bidId,
      userId: req.user.userId,
      amount: bid.amount
    });

    res.json({
      success: true,
      message: 'Bid withdrawn successfully',
      data: {
        refundAmount: bid.amount,
        transactionHash: unlockResult.transactionHash
      }
    });

  } catch (blockchainError) {
    logger.error('Blockchain bid withdrawal failed:', blockchainError);
    
    res.status(400).json({
      success: false,
      message: 'Failed to unlock tokens on blockchain',
      data: null
    });
  }
}));

// @route   GET /api/v1/bids/:id/status
// @desc    Check bid status
// @access  Private
router.get('/:bidId/status', [
  auth,
  param('bidId').isString().withMessage('Invalid bid ID')
], asyncHandler(async (req, res) => {
  const bid = await Bid.findOne({ bidId: req.params.bidId })
    .populate('auction.auctionRef', 'title status timing.endTime pricing.currentBid');
  
  if (!bid) {
    throw new NotFoundError('Bid not found');
  }

  // Check ownership
  if (bid.bidder.userId.toString() !== req.user.userId) {
    return res.status(403).json({
      success: false,
      message: 'Access denied - not bid owner',
      data: null
    });
  }

  res.json({
    success: true,
    message: 'Bid status retrieved successfully',
    data: {
      bid: {
        bidId: bid.bidId,
        amount: bid.amount,
        status: bid.status,
        placedAt: bid.timing.placedAt,
        auction: {
          title: bid.auction.auctionRef.title,
          status: bid.auction.auctionRef.status,
          currentBid: bid.auction.auctionRef.pricing.currentBid,
          endTime: bid.auction.auctionRef.timing.endTime
        },
        blockchain: {
          transactionHash: bid.blockchain.transactionHash,
          isOnChain: bid.blockchain.isOnChain
        }
      }
    }
  });
}));

module.exports = router;