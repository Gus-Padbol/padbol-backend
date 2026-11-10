import {projectGamesLedger} from './nationsGamesLedgerProjection.js';
/** Isolated adapter for the existing durable store. Reads state/revision/ledger
 * together; must be enabled only after the dedicated column exists. */
export function withGamesLedgerRead(BaseStore) {
 return class GamesLedgerStore extends BaseStore {
  async getMatch(matchId) {
   const r=await this.pool.query('SELECT revision, states, receipts, games_ledger, games_epoch, tracking_status FROM nations_marker_private.nations_marker_match WHERE match_id=$1',[matchId]);
   if(!r.rows[0])return null;
   const row=r.rows[0];const out={revision:Number(row.revision),states:row.states,receipts:row.receipts,gamesLedger:row.games_ledger,gamesEpoch:row.games_epoch,trackingStatus:row.tracking_status};
   this.validateMatch(matchId,out);return out;
  }
 };
}
export function withGamesParticipation(body,aggregate,teamId){
 if(aggregate?.trackingStatus==='reset_pending')return {...body,state:null,participation:{status:'unconfirmed',reason:'TRACKING_RESTART_REQUIRED'},gamesEpoch:aggregate.gamesEpoch,trackingStatus:'reset_pending',gamesParticipation:{status:'unconfirmed',reason:'TRACKING_RESTART_REQUIRED',players:null,totalGames:0}};
 return {...body,gamesEpoch:aggregate?.gamesEpoch,trackingStatus:aggregate?.trackingStatus,gamesParticipation:projectGamesLedger(aggregate,teamId)};
}
