// An opaque revision based on the existing timestamp; no schema change required.
export const SPACE_REVIEW_VERSION_SQL = "coalesce((extract(epoch from r.updated_at)*1000000)::bigint::text,'legacy')";
export const SPACE_REVIEW_UPDATED_AT_SQL = "greatest(clock_timestamp(),coalesce(r.updated_at,'-infinity'::timestamptz)+interval '1 microsecond')";
export function requireSpaceReviewVersion(req,res,next){
 const version=req.body?.expectedReviewVersion;
 if(typeof version!=='string'||! /^(?:[0-9]{1,22}|legacy)$/.test(version))return res.status(400).json({code:'REVIEW_VERSION_REQUIRED',error:'Actualiza la ficha antes de cambiar la revisión.'});
 return next();
}
