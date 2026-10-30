import {NextResponse} from 'next/server';import {requireRole} from '@/lib/auth/session';import {authErrorResponse} from '@/lib/auth/guards';// Test endpoint: remove during admin phase.
export async function GET(){try{await requireRole('OWNER');return NextResponse.json({owner:true})}catch(error){return authErrorResponse(error)}}
