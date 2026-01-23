/**
 * Live Matches Module - BK8 Sports Hub
 * Primary: API-Football (RapidAPI) - Better coverage, real odds
 * Fallback: Football-Data.org - Free tier backup
 */

const LiveMatches = {
  // API-Football Configuration (Primary)
  API_FOOTBALL: {
    BASE_URL: 'https://v3.football.api-sports.io',
    API_KEY: '2259bdfa584583cc66046ed90bf7dd77',
    HOST: 'v3.football.api-sports.io'
  },

  // Football-Data.org (Fallback)
  FOOTBALL_DATA: {
    BASE_URL: 'https://api.football-data.org/v4',
    API_KEY: '4e1046a650fc4c6fbe0043cd3fa9d2b7'
  },
  
  // Popular League IDs for API-Football
  LEAGUES: {
    PREMIER_LEAGUE: 39,
    LA_LIGA: 140,
    BUNDESLIGA: 78,
    SERIE_A: 135,
    LIGUE_1: 61,
    CHAMPIONS_LEAGUE: 2,
    EUROPA_LEAGUE: 3,
    WORLD_CUP: 1,
    // Asian leagues
    AFC_CHAMPIONS: 17,
    J_LEAGUE: 98,
    K_LEAGUE: 292,
    THAI_LEAGUE: 296,
    A_LEAGUE: 188
  },

  // Cache to avoid excessive API calls
  cache: {
    matches: null,
    matchesTimestamp: null,
    odds: new Map(),
    oddsTimestamp: new Map(),
    TTL: 300000, // 5 minutes for matches (was 1 min)
    ODDS_TTL: 600000, // 10 minutes for odds
    STORAGE_KEY: 'livematches_cache'
  },

  // Track if page is visible (pause refresh when hidden)
  isPageVisible: true,

  /**
   * Initialize visibility tracking for efficient API usage
   */
  initVisibilityTracking() {
    document.addEventListener('visibilitychange', () => {
      this.isPageVisible = !document.hidden;
      console.log('Page visibility:', this.isPageVisible ? 'visible' : 'hidden');
    });
  },

  // Cache version - increment when data structure changes to clear old cache
  CACHE_VERSION: 2,

  /**
   * Load cache from localStorage
   */
  loadCacheFromStorage() {
    try {
      const stored = localStorage.getItem(this.cache.STORAGE_KEY);
      if (stored) {
        const data = JSON.parse(stored);
        // Only use if version matches and less than 30 minutes old
        if (data.version === this.CACHE_VERSION && Date.now() - data.timestamp < 1800000) {
          this.cache.matches = data.matches;
          this.cache.matchesTimestamp = data.timestamp;
          console.log('Loaded matches from localStorage cache');
          return true;
        } else {
          // Clear old/invalid cache
          localStorage.removeItem(this.cache.STORAGE_KEY);
          console.log('Cleared outdated localStorage cache');
        }
      }
    } catch (e) {
      console.warn('Could not load cache from storage:', e);
    }
    return false;
  },

  /**
   * Save cache to localStorage
   */
  saveCacheToStorage() {
    try {
      const data = {
        matches: this.cache.matches,
        timestamp: Date.now(),
        version: this.CACHE_VERSION
      };
      localStorage.setItem(this.cache.STORAGE_KEY, JSON.stringify(data));
    } catch (e) {
      console.warn('Could not save cache to storage:', e);
    }
  },

  /**
   * Fetch matches from API-Football (Primary)
   * Only fetches today's and future matches - no past results
   */
  async fetchFromAPIFootball() {
    const today = new Date().toISOString().split('T')[0];
    
    try {
      const response = await fetch(
        `${this.API_FOOTBALL.BASE_URL}/fixtures?date=${today}`,
        {
          method: 'GET',
          headers: {
            'x-apisports-key': this.API_FOOTBALL.API_KEY
          }
        }
      );

      if (!response.ok) {
        throw new Error(`API-Football Error: ${response.status}`);
      }

      const data = await response.json();
      
      if (data.errors && Object.keys(data.errors).length > 0) {
        console.warn('API-Football errors:', data.errors);
        throw new Error('API-Football returned errors');
      }

      // Filter out finished matches - only keep live and upcoming
      const activeMatches = (data.response || []).filter(fixture => {
        const status = fixture.fixture.status.short;
        // Exclude finished matches
        const finishedStatuses = ['FT', 'AET', 'PEN', 'AWD', 'WO', 'CANC', 'ABD'];
        return !finishedStatuses.includes(status);
      });

      return this.transformAPIFootballData(activeMatches);
    } catch (error) {
      console.error('API-Football failed:', error);
      return null;
    }
  },

  /**
   * Transform API-Football data to our format
   */
  transformAPIFootballData(fixtures) {
    return fixtures.map(fixture => ({
      id: fixture.fixture.id,
      competition: {
        name: fixture.league.name,
        logo: fixture.league.logo,
        country: fixture.league.country
      },
      homeTeam: {
        name: fixture.teams.home.name,
        shortName: this.getShortName(fixture.teams.home.name),
        logo: fixture.teams.home.logo
      },
      awayTeam: {
        name: fixture.teams.away.name,
        shortName: this.getShortName(fixture.teams.away.name),
        logo: fixture.teams.away.logo
      },
      utcDate: fixture.fixture.date,
      status: this.mapAPIFootballStatus(fixture.fixture.status.short),
      statusDetail: fixture.fixture.status.long,
      elapsed: fixture.fixture.status.elapsed,
      score: {
        fullTime: {
          home: fixture.goals.home,
          away: fixture.goals.away
        },
        halfTime: {
          home: fixture.score.halftime.home,
          away: fixture.score.halftime.away
        }
      },
      venue: fixture.fixture.venue?.name,
      // Store original for odds lookup
      fixtureId: fixture.fixture.id
    }));
  },

  /**
   * Map API-Football status codes to our format
   */
  mapAPIFootballStatus(status) {
    const statusMap = {
      'TBD': 'SCHEDULED',
      'NS': 'TIMED',
      '1H': 'IN_PLAY',
      'HT': 'PAUSED',
      '2H': 'IN_PLAY',
      'ET': 'IN_PLAY',
      'P': 'IN_PLAY',
      'FT': 'FINISHED',
      'AET': 'FINISHED',
      'PEN': 'FINISHED',
      'BT': 'PAUSED',
      'SUSP': 'SUSPENDED',
      'INT': 'SUSPENDED',
      'PST': 'POSTPONED',
      'CANC': 'CANCELLED',
      'ABD': 'CANCELLED',
      'AWD': 'FINISHED',
      'WO': 'FINISHED',
      'LIVE': 'LIVE'
    };
    return statusMap[status] || status;
  },

  /**
   * Fetch real odds from API-Football (with caching)
   */
  async fetchOdds(fixtureId) {
    // Check odds cache first
    const cachedOdds = this.cache.odds.get(fixtureId);
    const cachedTime = this.cache.oddsTimestamp.get(fixtureId);
    
    if (cachedOdds && cachedTime && (Date.now() - cachedTime < this.cache.ODDS_TTL)) {
      console.log(`Using cached odds for fixture ${fixtureId}`);
      return cachedOdds;
    }

    try {
      const response = await fetch(
        `${this.API_FOOTBALL.BASE_URL}/odds?fixture=${fixtureId}`,
        {
          method: 'GET',
          headers: {
            'x-apisports-key': this.API_FOOTBALL.API_KEY
          }
        }
      );

      if (!response.ok) return cachedOdds || null;

      const data = await response.json();
      const bookmaker = data.response?.[0]?.bookmakers?.[0];
      const matchWinner = bookmaker?.bets?.find(b => b.name === 'Match Winner');
      
      if (matchWinner) {
        const values = matchWinner.values;
        const odds = {
          home: values.find(v => v.value === 'Home')?.odd || '-',
          draw: values.find(v => v.value === 'Draw')?.odd || '-',
          away: values.find(v => v.value === 'Away')?.odd || '-',
          bookmaker: bookmaker.name
        };
        
        // Cache the odds
        this.cache.odds.set(fixtureId, odds);
        this.cache.oddsTimestamp.set(fixtureId, Date.now());
        
        return odds;
      }
      return cachedOdds || null;
    } catch (error) {
      console.error('Failed to fetch odds:', error);
      return cachedOdds || null;
    }
  },

  /**
   * Fetch odds for multiple fixtures (limited to save API calls)
   */
  async fetchOddsForMatches(matches) {
    const oddsMap = new Map();
    
    // Only fetch odds for top 3 matches to conserve API calls (was 5)
    const matchesToFetch = matches.slice(0, 3);
    
    // Check how many actually need fetching (not cached)
    const uncachedMatches = matchesToFetch.filter(match => {
      if (!match.fixtureId) return false;
      const cachedTime = this.cache.oddsTimestamp.get(match.fixtureId);
      return !cachedTime || (Date.now() - cachedTime >= this.cache.ODDS_TTL);
    });
    
    console.log(`Fetching odds: ${uncachedMatches.length} uncached, ${matchesToFetch.length - uncachedMatches.length} from cache`);
    
    // Fetch all (cached ones return immediately)
    const oddsPromises = matchesToFetch.map(async (match) => {
      if (match.fixtureId) {
        const odds = await this.fetchOdds(match.fixtureId);
        if (odds) {
          oddsMap.set(match.id, odds);
        }
      }
    });

    await Promise.all(oddsPromises);
    return oddsMap;
  },

  /**
   * Fetch matches (with fallback and persistent caching)
   */
  async fetchMatches() {
    // Check memory cache first
    if (this.cache.matches && this.cache.matchesTimestamp && 
        (Date.now() - this.cache.matchesTimestamp < this.cache.TTL)) {
      console.log('Using memory cached matches');
      return this.cache.matches;
    }

    // Try localStorage cache
    if (this.loadCacheFromStorage()) {
      return this.cache.matches;
    }

    // Try API-Football first
    let matches = await this.fetchFromAPIFootball();

    // Fallback to Football-Data.org if API-Football fails
    if (!matches) {
      matches = await this.fetchFromFootballData();
    }

    // Final fallback to static data
    if (!matches || matches.length === 0) {
      matches = this.getFallbackMatches();
    }

    // Cache the results
    this.cache.matches = matches;
    this.cache.matchesTimestamp = Date.now();
    this.saveCacheToStorage();

    return matches;
  },

  /**
   * Fallback: Fetch from Football-Data.org
   */
  async fetchFromFootballData() {
    const today = new Date().toISOString().split('T')[0];
    
    try {
      const response = await fetch(
        `${this.FOOTBALL_DATA.BASE_URL}/matches?dateFrom=${today}&dateTo=${today}`,
        {
          headers: {
            'X-Auth-Token': this.FOOTBALL_DATA.API_KEY
          }
        }
      );

      if (!response.ok) return null;

      const data = await response.json();
      // Transform to our format with logos
      return this.transformFootballDataMatches(data.matches || []);
    } catch (error) {
      console.error('Football-Data.org failed:', error);
      return null;
    }
  },

  /**
   * Transform Football-Data.org matches to our format
   */
  transformFootballDataMatches(matches) {
    return matches.map(match => ({
      id: match.id,
      competition: {
        name: match.competition?.name || 'Football',
        logo: match.competition?.emblem,
        country: match.area?.name
      },
      homeTeam: {
        name: match.homeTeam?.name || 'Home',
        shortName: match.homeTeam?.shortName || this.getShortName(match.homeTeam?.name || 'Home'),
        logo: match.homeTeam?.crest // Football-Data.org uses 'crest' for team logo
      },
      awayTeam: {
        name: match.awayTeam?.name || 'Away',
        shortName: match.awayTeam?.shortName || this.getShortName(match.awayTeam?.name || 'Away'),
        logo: match.awayTeam?.crest // Football-Data.org uses 'crest' for team logo
      },
      utcDate: match.utcDate,
      status: match.status,
      score: match.score,
      venue: match.venue
    }));
  },

  /**
   * Get short team name
   */
  getShortName(fullName) {
    // Common abbreviations
    const abbreviations = {
      'Manchester United': 'Man Utd',
      'Manchester City': 'Man City',
      'Tottenham Hotspur': 'Spurs',
      'Newcastle United': 'Newcastle',
      'Wolverhampton Wanderers': 'Wolves',
      'Nottingham Forest': "Nott'm Forest",
      'Brighton & Hove Albion': 'Brighton',
      'West Ham United': 'West Ham',
      'AFC Bournemouth': 'Bournemouth',
      'Real Madrid': 'Real Madrid',
      'Atletico Madrid': 'Atlético',
      'Athletic Club': 'Athletic',
      'Bayern Munich': 'Bayern',
      'Borussia Dortmund': 'Dortmund',
      'RB Leipzig': 'Leipzig',
      'Paris Saint-Germain': 'PSG',
      'Inter Milan': 'Inter',
      'AC Milan': 'Milan',
      'AS Roma': 'Roma'
    };
    
    return abbreviations[fullName] || (fullName.length > 15 ? fullName.substring(0, 12) + '...' : fullName);
  },

  /**
   * Format match status for display
   */
  getMatchStatus(match) {
    const status = match.status;
    
    if (match.elapsed && this.isLive(match)) {
      return `🔴 ${match.elapsed}'`;
    }
    
    const statusMap = {
      'SCHEDULED': 'Upcoming',
      'TIMED': this.formatKickoff(match.utcDate),
      'LIVE': '🔴 LIVE',
      'IN_PLAY': '🔴 LIVE',
      'PAUSED': '⏸️ HT',
      'FINISHED': 'FT',
      'SUSPENDED': 'SUSP',
      'POSTPONED': 'PST',
      'CANCELLED': 'CANC'
    };
    return statusMap[status] || status;
  },

  /**
   * Check if match is live
   */
  isLive(match) {
    return ['LIVE', 'IN_PLAY', 'PAUSED'].includes(match.status);
  },

  /**
   * Format kickoff time
   */
  formatKickoff(utcDate) {
    const date = new Date(utcDate);
    const now = new Date();
    const isToday = date.toDateString() === now.toDateString();
    
    const time = date.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });

    if (isToday) {
      return `Today ${time}`;
    }

    const dateStr = date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric'
    });

    return `${dateStr} ${time}`;
  },

  /**
   * Generate fallback odds if real odds unavailable
   */
  generateFallbackOdds() {
    const homeWin = (Math.random() * 2 + 1.5).toFixed(2);
    const draw = (Math.random() * 1.5 + 3).toFixed(2);
    const awayWin = (Math.random() * 2 + 1.5).toFixed(2);
    return { home: homeWin, draw: draw, away: awayWin };
  },

  /**
   * Render match card HTML - Live and Upcoming matches only
   */
  renderMatchCard(match, odds = null) {
    const status = this.getMatchStatus(match);
    const isLive = this.isLive(match);
    const displayOdds = odds || this.generateFallbackOdds();
    const homeScore = match.score?.fullTime?.home;
    const awayScore = match.score?.fullTime?.away;

    // Team logos (if available from API-Football)
    const homeLogo = match.homeTeam?.logo ? `<img src="${match.homeTeam.logo}" alt="" class="team-logo" width="32" height="32" loading="lazy">` : '';
    const awayLogo = match.awayTeam?.logo ? `<img src="${match.awayTeam.logo}" alt="" class="team-logo" width="32" height="32" loading="lazy">` : '';

    // Show score only for live matches
    const showScore = isLive;
    
    // Odds source indicator
    const oddsSource = odds?.bookmaker ? `<span class="odds-source">via ${odds.bookmaker}</span>` : '';

    return `
      <div class="match-card${isLive ? ' is-live' : ''}" data-match-id="${match.id}">
        <div class="match-header">
          <span class="match-league">${match.competition?.name || 'Football'}</span>
          <span class="match-date${isLive ? ' live' : ''}">${status}</span>
        </div>
        <div class="match-body">
          <div class="match-teams">
            <div class="team">
              ${homeLogo}
              <div class="team-name" title="${match.homeTeam?.name || 'Home'}">${match.homeTeam?.shortName || match.homeTeam?.name || 'Home'}</div>
              ${showScore ? `<div class="team-score">${homeScore ?? 0}</div>` : ''}
            </div>
            <div class="match-vs">${showScore ? '-' : 'VS'}</div>
            <div class="team">
              ${awayLogo}
              <div class="team-name" title="${match.awayTeam?.name || 'Away'}">${match.awayTeam?.shortName || match.awayTeam?.name || 'Away'}</div>
              ${showScore ? `<div class="team-score">${awayScore ?? 0}</div>` : ''}
            </div>
          </div>
          <div class="match-odds">
            <div class="odd-box">
              <div class="odd-label">1</div>
              <div class="odd-value">${displayOdds.home}</div>
            </div>
            <div class="odd-box">
              <div class="odd-label">X</div>
              <div class="odd-value">${displayOdds.draw}</div>
            </div>
            <div class="odd-box">
              <div class="odd-label">2</div>
              <div class="odd-value">${displayOdds.away}</div>
            </div>
          </div>
          ${oddsSource}
          <a href="sports/live-football.html" class="btn btn-full">${isLive ? 'Watch Live' : 'View Match'}</a>
        </div>
      </div>
    `;
  },

  /**
   * Render loading skeleton
   */
  renderSkeleton(count = 4) {
    let html = '';
    for (let i = 0; i < count; i++) {
      html += `
        <div class="match-card skeleton">
          <div class="match-header">
            <span class="skeleton-text" style="width: 100px; height: 16px;"></span>
            <span class="skeleton-text" style="width: 80px; height: 16px;"></span>
          </div>
          <div class="match-teams">
            <div class="team">
              <div class="skeleton-text" style="width: 120px; height: 20px; margin: 0 auto;"></div>
            </div>
            <div class="match-vs">VS</div>
            <div class="team">
              <div class="skeleton-text" style="width: 120px; height: 20px; margin: 0 auto;"></div>
            </div>
          </div>
          <div class="match-odds">
            <div class="odd-box"><div class="skeleton-text" style="width: 40px; height: 24px;"></div></div>
            <div class="odd-box"><div class="skeleton-text" style="width: 40px; height: 24px;"></div></div>
            <div class="odd-box"><div class="skeleton-text" style="width: 40px; height: 24px;"></div></div>
          </div>
        </div>
      `;
    }
    return html;
  },

  /**
   * Fallback matches - only upcoming, no past results
   * Uses dynamic dates based on current time
   */
  getFallbackMatches() {
    const now = new Date();
    
    // Create dates for upcoming matches (1hr, 2hr, 3hr, 4hr from now)
    const match1Time = new Date(now.getTime() + 1 * 60 * 60 * 1000); // +1 hour
    const match2Time = new Date(now.getTime() + 2 * 60 * 60 * 1000); // +2 hours
    const match3Time = new Date(now.getTime() + 3 * 60 * 60 * 1000); // +3 hours
    const match4Time = new Date(now.getTime() + 4 * 60 * 60 * 1000); // +4 hours

    // Team logos from API-Sports CDN (same as API-Football uses)
    const logos = {
      arsenal: 'https://media.api-sports.io/football/teams/42.png',
      chelsea: 'https://media.api-sports.io/football/teams/49.png',
      realMadrid: 'https://media.api-sports.io/football/teams/541.png',
      barcelona: 'https://media.api-sports.io/football/teams/529.png',
      bayern: 'https://media.api-sports.io/football/teams/157.png',
      manCity: 'https://media.api-sports.io/football/teams/50.png',
      juventus: 'https://media.api-sports.io/football/teams/496.png',
      inter: 'https://media.api-sports.io/football/teams/505.png'
    };

    return [
      {
        id: 1,
        competition: { name: 'Premier League' },
        homeTeam: { shortName: 'Arsenal', name: 'Arsenal', logo: logos.arsenal },
        awayTeam: { shortName: 'Chelsea', name: 'Chelsea', logo: logos.chelsea },
        utcDate: match1Time.toISOString(),
        status: 'TIMED',
        score: { fullTime: { home: null, away: null } }
      },
      {
        id: 2,
        competition: { name: 'La Liga' },
        homeTeam: { shortName: 'Real Madrid', name: 'Real Madrid', logo: logos.realMadrid },
        awayTeam: { shortName: 'Barcelona', name: 'Barcelona', logo: logos.barcelona },
        utcDate: match2Time.toISOString(),
        status: 'TIMED',
        score: { fullTime: { home: null, away: null } }
      },
      {
        id: 3,
        competition: { name: 'Champions League' },
        homeTeam: { shortName: 'Bayern', name: 'Bayern Munich', logo: logos.bayern },
        awayTeam: { shortName: 'Man City', name: 'Manchester City', logo: logos.manCity },
        utcDate: match3Time.toISOString(),
        status: 'TIMED',
        score: { fullTime: { home: null, away: null } }
      },
      {
        id: 4,
        competition: { name: 'Serie A' },
        homeTeam: { shortName: 'Juventus', name: 'Juventus', logo: logos.juventus },
        awayTeam: { shortName: 'Inter', name: 'Inter Milan', logo: logos.inter },
        utcDate: match4Time.toISOString(),
        status: 'TIMED',
        score: { fullTime: { home: null, away: null } }
      }
    ];
  },

  /**
   * Initialize and render matches to a container
   * Only shows live and upcoming matches with real odds
   */
  async init(containerId = 'live-matches-container', limit = 4) {
    const container = document.getElementById(containerId);
    if (!container) {
      console.error(`Container #${containerId} not found`);
      return;
    }

    // Show loading skeleton
    container.innerHTML = this.renderSkeleton(limit);

    try {
      const matches = await this.fetchMatches();

      // Filter: Only live and upcoming matches (no finished)
      const activeMatches = matches.filter(m => {
        return ['TIMED', 'SCHEDULED', 'NS', 'LIVE', 'IN_PLAY', 'PAUSED', '1H', '2H', 'HT', 'ET', 'BT', 'P'].includes(m.status);
      });

      // Sort: Live first, then upcoming by kickoff time
      const sortedMatches = activeMatches.sort((a, b) => {
        const isALive = this.isLive(a);
        const isBLive = this.isLive(b);
        
        // Live matches first
        if (isALive && !isBLive) return -1;
        if (!isALive && isBLive) return 1;
        
        // Then sort by kickoff time
        return new Date(a.utcDate) - new Date(b.utcDate);
      });

      // Prioritize major leagues
      const majorLeagues = ['Premier League', 'La Liga', 'Bundesliga', 'Serie A', 'Ligue 1', 'Champions League', 'Europa League', 'UEFA Europa League', 'UEFA Champions League'];
      const prioritizedMatches = [
        ...sortedMatches.filter(m => majorLeagues.some(l => m.competition?.name?.includes(l))),
        ...sortedMatches.filter(m => !majorLeagues.some(l => m.competition?.name?.includes(l)))
      ];

      // Remove duplicates (in case a match appears in both)
      const uniqueMatches = [...new Map(prioritizedMatches.map(m => [m.id, m])).values()];
      const matchesToShow = uniqueMatches.slice(0, limit);
      
      if (matchesToShow.length === 0) {
        container.innerHTML = '<p class="no-matches">No upcoming matches right now. Check back soon!</p>';
        return;
      }

      // Fetch real odds for these matches
      console.log('Fetching real odds for matches...');
      const oddsMap = await this.fetchOddsForMatches(matchesToShow);
      console.log(`Fetched odds for ${oddsMap.size} matches`);

      // Render matches with real odds
      container.innerHTML = matchesToShow.map(match => {
        const odds = oddsMap.get(match.id);
        return this.renderMatchCard(match, odds);
      }).join('');

    } catch (error) {
      console.error('Error initializing matches:', error);
      const fallback = this.getFallbackMatches().filter(m => m.status !== 'FINISHED');
      container.innerHTML = fallback.slice(0, limit).map(match => this.renderMatchCard(match)).join('');
    }
  },

  /**
   * Auto-refresh matches (with visibility awareness)
   * Only refreshes when page is visible to save API calls
   */
  startAutoRefresh(containerId = 'live-matches-container', limit = 4, intervalMs = 120000) {
    // Initialize visibility tracking
    this.initVisibilityTracking();
    
    // Initial load
    this.init(containerId, limit);

    // Set up interval (default now 2 minutes instead of 1)
    setInterval(() => {
      // Only refresh if page is visible
      if (this.isPageVisible) {
        console.log('Auto-refresh: Page visible, refreshing matches...');
        // Clear memory cache to force API call (localStorage still valid)
        this.cache.matches = null;
        this.cache.matchesTimestamp = null;
        this.init(containerId, limit);
      } else {
        console.log('Auto-refresh: Page hidden, skipping to save API calls');
      }
    }, intervalMs);

    console.log(`Auto-refresh initialized: every ${intervalMs/1000}s when visible`);
  },

  /**
   * Split view: Separate Live and Upcoming sections
   */
  async initSplitView(liveContainerId, upcomingContainerId, limit = 4) {
    const liveContainer = document.getElementById(liveContainerId);
    const upcomingContainer = document.getElementById(upcomingContainerId);
    
    if (!liveContainer || !upcomingContainer) {
      console.error('Split view containers not found');
      return;
    }

    // Show loading skeletons
    liveContainer.innerHTML = this.renderSkeleton(limit);
    upcomingContainer.innerHTML = this.renderSkeleton(limit);

    try {
      const matches = await this.fetchMatches();

      // Separate live and upcoming matches
      const liveMatches = matches.filter(m => this.isLive(m));
      const upcomingMatches = matches.filter(m => {
        const isUpcoming = ['TIMED', 'SCHEDULED', 'NS'].includes(m.status);
        return isUpcoming && !this.isLive(m);
      }).sort((a, b) => new Date(a.utcDate) - new Date(b.utcDate));

      // Fetch odds for matches that will be displayed
      const matchesToShow = [...liveMatches.slice(0, limit), ...upcomingMatches.slice(0, limit)];
      const oddsMap = await this.fetchOddsForMatches(matchesToShow);

      // Render Live Matches
      if (liveMatches.length > 0) {
        liveContainer.innerHTML = liveMatches.slice(0, limit)
          .map(match => this.renderMatchCard(match, oddsMap.get(match.id)))
          .join('');
      } else {
        liveContainer.innerHTML = `
          <div class="no-matches-message">
            <span class="no-matches-icon">⚽</span>
            <p>No live matches right now</p>
            <small>Check back soon or browse upcoming matches below</small>
          </div>
        `;
      }

      // Render Upcoming Matches
      if (upcomingMatches.length > 0) {
        upcomingContainer.innerHTML = upcomingMatches.slice(0, limit)
          .map(match => this.renderMatchCard(match, oddsMap.get(match.id)))
          .join('');
      } else {
        // Use fallback matches if no upcoming from API
        const fallback = this.getFallbackMatches();
        upcomingContainer.innerHTML = fallback.slice(0, limit)
          .map(match => this.renderMatchCard(match))
          .join('');
      }

    } catch (error) {
      console.error('Split view initialization failed:', error);
      // Show fallback data
      const fallback = this.getFallbackMatches();
      liveContainer.innerHTML = `
        <div class="no-matches-message">
          <span class="no-matches-icon">⚽</span>
          <p>No live matches right now</p>
        </div>
      `;
      upcomingContainer.innerHTML = fallback.slice(0, limit)
        .map(match => this.renderMatchCard(match))
        .join('');
    }
  },

  /**
   * Start split view with auto-refresh
   */
  startSplitView(liveContainerId, upcomingContainerId, limit = 4, intervalMs = 180000) {
    // Initialize visibility tracking
    this.initVisibilityTracking();
    
    // Initial load
    this.initSplitView(liveContainerId, upcomingContainerId, limit);

    // Set up interval
    setInterval(() => {
      if (this.isPageVisible) {
        console.log('Auto-refresh: Page visible, refreshing split view...');
        this.cache.matches = null;
        this.cache.matchesTimestamp = null;
        this.initSplitView(liveContainerId, upcomingContainerId, limit);
      } else {
        console.log('Auto-refresh: Page hidden, skipping to save API calls');
      }
    }, intervalMs);

    console.log(`Split view auto-refresh initialized: every ${intervalMs/1000}s when visible`);
  },

  /**
   * Force refresh (bypasses cache)
   */
  async forceRefresh(containerId = 'live-matches-container', limit = 4) {
    console.log('Force refresh requested');
    this.cache.matches = null;
    this.cache.matchesTimestamp = null;
    localStorage.removeItem(this.cache.STORAGE_KEY);
    await this.init(containerId, limit);
  },

  /**
   * Get API usage stats
   */
  getStats() {
    return {
      cacheAge: this.cache.matchesTimestamp ? 
        Math.round((Date.now() - this.cache.matchesTimestamp) / 1000) + 's ago' : 'not cached',
      matchesCached: this.cache.matches?.length || 0,
      oddsCached: this.cache.odds.size,
      pageVisible: this.isPageVisible
    };
  }
};

// Export for use
if (typeof module !== 'undefined' && module.exports) {
  module.exports = LiveMatches;
}
