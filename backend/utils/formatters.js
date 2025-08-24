const formatTokenAmount = (amount, decimals = 18) => {
  const num = parseFloat(amount);
  if (isNaN(num)) return '0';
  if (num >= 1000000) {
    return `${(num / 1000000).toFixed(2)}M`;
  } else if (num >= 1000) {
    return `${(num / 1000).toFixed(2)}K`;
  }
  return num.toFixed(2);
};

const formatTimeRemaining = (endTimeSeconds) => {
  const now = Math.floor(Date.now() / 1000);
  const remaining = endTimeSeconds - now;
  
  if (remaining <= 0) return 'Ended';
  
  const hours = Math.floor(remaining / 3600);
  const minutes = Math.floor((remaining % 3600) / 60);
  const seconds = remaining % 60;
  
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  } else {
    return `${seconds}s`;
  }
};

const formatAddress = (address, length = 6) => {
  if (!address) return '';
  return `${address.slice(0, length)}...${address.slice(-4)}`;
};

module.exports = {
  formatTokenAmount,
  formatTimeRemaining,
  formatAddress
};