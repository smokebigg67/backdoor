import { Badge } from '@/components/ui/badge';
import { formatTokenAmount } from '@/utils/formatters';

interface AuctionCardProps {
  item: string;
  currentBid: string;
  timeLeft: string;
  category: string;
  isHot?: boolean;
  auctionType?: 'forward' | 'reverse';
  watchers?: number;
}

export const AuctionCard = ({ item, currentBid, timeLeft, category, isHot, auctionType = 'forward', watchers }: AuctionCardProps) => {
  const isUrgent = timeLeft.includes('m') && parseInt(timeLeft) < 10;
  const isReverse = auctionType === 'reverse';
  
  return (
    <div className={`border border-panel-border bg-secondary/20 p-2 transition-all hover:bg-secondary/30 hover:border-terminal-green/50 ${isHot ? 'animate-glow' : ''}`}>
      <div className="text-xs">
        <div className="flex items-center gap-2">
          <div className="text-foreground font-medium">{item}</div>
          {isHot && <div className="w-2 h-2 bg-auction-active rounded-full animate-pulse-slow"></div>}
          {isReverse && <div className="text-xs bg-terminal-amber/20 text-terminal-amber px-1 rounded">REV</div>}
        </div>
        <div className="mt-1 flex justify-between items-center">
          <span className="text-muted-foreground">{category}</span>
          {watchers && <span className="text-xs text-muted-foreground">{watchers} watching</span>}
        </div>
        <div className="mt-1 flex justify-between">
          <span className="text-terminal-green">
            {isReverse ? 'Lowest: ' : 'Current: '}{currentBid} WKC
          </span>
          <span className={`${isUrgent ? 'text-warning-flash animate-pulse' : 'text-terminal-red'}`}>
            {timeLeft}
          </span>
        </div>
        <div className="mt-2 flex gap-2">
          <button className="bg-secondary hover:bg-accent px-2 py-1 text-xs transition-colors">
            Watch
          </button>
          <button className="bg-primary hover:bg-primary/80 px-2 py-1 text-xs text-primary-foreground transition-colors">
            {isReverse ? 'Submit Quote →' : 'Place Bid →'}
          </button>
        </div>
      </div>
    </div>
  );
};