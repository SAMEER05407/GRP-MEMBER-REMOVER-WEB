
const { makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const fs = require('fs-extra');
const path = require('path');

class WhatsAppHandler {
  constructor(userId, io) {
    this.userId = userId;
    this.io = io;
    this.sock = null;
    this.qrCode = null;
    this.connected = false;
    this.sessionPath = path.join(__dirname, 'sessions', userId);
  }

  async initialize() {
    try {
      // Check if session exists
      const sessionExists = await fs.pathExists(this.sessionPath);
      console.log(`Session exists for user ${this.userId}: ${sessionExists}`);
      
      // Ensure session directory exists
      await fs.ensureDir(this.sessionPath);
      
      // Get latest Baileys version
      const { version, isLatest } = await fetchLatestBaileysVersion();
      console.log(`Using Baileys v${version.join('.')}, isLatest: ${isLatest}`);
      
      // Load auth state
      const { state, saveCreds } = await useMultiFileAuthState(this.sessionPath);
      
      // Create socket connection
      this.sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        generateHighQualityLinkPreview: true,
      });
      
      // Handle credentials update
      this.sock.ev.on('creds.update', saveCreds);
      
      // Handle connection updates
      this.sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        const userId = this.userId;
        
        if (qr) {
          try {
            console.log(`📱 Generating new QR code for user ${userId}`);
            this.qrCode = await QRCode.toDataURL(qr);
            this.io.to(`user-${userId}`).emit('qr-code', this.qrCode);
            console.log(`✅ New QR Code generated and sent to user ${userId}`);
          } catch (error) {
            console.error(`❌ Error generating QR code for user ${userId}:`, error);
            this.io.to(`user-${userId}`).emit('qr-error', 'Failed to generate QR code');
          }
        }
        
        if (connection === 'close') {
          const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
          const reason = lastDisconnect?.error?.output?.statusCode || 'unknown';
          
          console.log(`🔌 Connection closed for user ${userId}. Reason: ${reason}, Will reconnect: ${shouldReconnect}`);
          
          this.connected = false;
          this.qrCode = null;
          this.io.to(`user-${userId}`).emit('connection-status', { connected: false });
          this.io.to(`user-${userId}`).emit('qr-code', null);
          
          if (shouldReconnect && this.sock) { // Only reconnect if socket still exists (not manually disconnected)
            console.log(`🔄 Attempting to reconnect user ${userId} in 3 seconds...`);
            setTimeout(() => {
              if (this.sock) { // Double check socket still exists before reconnecting
                this.initialize();
              } else {
                console.log(`🚫 Skipping reconnection for user ${userId} - socket was manually cleared`);
              }
            }, 3000);
          } else {
            console.log(`🚪 User ${userId} logged out or manually disconnected - session will require fresh authentication`);
            // Clear session when logged out to force new QR
            try {
              await this.clearSession();
              console.log(`🗑️ Session cleared after logout for user ${userId}`);
            } catch (error) {
              console.error(`❌ Error clearing session after logout for user ${userId}:`, error);
            }
          }
        } else if (connection === 'open') {
          console.log(`✅ WhatsApp successfully connected for user ${userId}`);
          this.connected = true;
          this.qrCode = null;
          this.io.to(`user-${userId}`).emit('connection-status', { connected: true });
          this.io.to(`user-${userId}`).emit('qr-code', null);
        } else if (connection === 'connecting') {
          console.log(`🔄 WhatsApp connecting for user ${userId}...`);
        }
      });
      
      // Handle messages (optional - for debugging)
      this.sock.ev.on('messages.upsert', async (m) => {
        // console.log('Received message:', JSON.stringify(m, undefined, 2));
      });
      
    } catch (error) {
      console.error('Error initializing WhatsApp:', error);
      throw error;
    }
  }

  async disconnect() {
    const userId = this.userId;
    console.log(`🔌 Starting disconnect process for user ${userId}`);
    
    try {
      // Close socket connection if exists
      if (this.sock) {
        console.log(`📱 Logging out WhatsApp socket for user ${userId}`);
        try {
          await this.sock.logout();
          console.log(`✅ WhatsApp socket logged out successfully for user ${userId}`);
        } catch (logoutError) {
          console.error(`⚠️ Error during socket logout for user ${userId}:`, logoutError);
          // Continue with cleanup even if logout fails
        }
        
        // Clean up socket reference
        this.sock = null;
        console.log(`🧹 Socket reference cleared for user ${userId}`);
      } else {
        console.log(`ℹ️ No active socket found for user ${userId}`);
      }
      
      // Reset connection state
      this.connected = false;
      this.qrCode = null;
      console.log(`🔄 Connection state reset for user ${userId}`);
      
      // Emit final disconnect status
      if (this.io) {
        this.io.to(`user-${userId}`).emit('connection-status', { connected: false });
        this.io.to(`user-${userId}`).emit('qr-code', null);
        console.log(`📡 Disconnect status emitted to client for user ${userId}`);
      }
      
      // Delete session files to force fresh authentication
      await this.clearSession();
      console.log(`✅ WhatsApp disconnected and session cleared for user ${userId}`);
      
    } catch (error) {
      console.error(`❌ Error during disconnect process for user ${userId}:`, error);
      
      // Force cleanup even if disconnect failed
      this.sock = null;
      this.connected = false;
      this.qrCode = null;
      
      // Still try to clear session even if logout failed
      try {
        await this.clearSession();
        console.log(`🆘 Session forcefully cleared after disconnect error for user ${userId}`);
      } catch (clearError) {
        console.error(`💥 Critical error clearing session during disconnect for user ${userId}:`, clearError);
      }
      
      // Don't throw the error, allow cleanup to complete
    }
  }

  async clearSession() {
    const userId = this.userId;
    const sessionPath = this.sessionPath;
    
    try {
      console.log(`🗂️ Checking session directory for user ${userId}: ${sessionPath}`);
      
      if (await fs.pathExists(sessionPath)) {
        console.log(`🗑️ Deleting session directory for user ${userId}`);
        await fs.remove(sessionPath);
        console.log(`✅ Session deleted successfully for user ${userId} at path: ${sessionPath}`);
      } else {
        console.log(`ℹ️ No session directory found to delete for user ${userId} at path: ${sessionPath}`);
      }
      
      // Verify deletion
      const stillExists = await fs.pathExists(sessionPath);
      if (stillExists) {
        console.warn(`⚠️ Session directory still exists after deletion attempt for user ${userId}`);
      } else {
        console.log(`✅ Session deletion verified for user ${userId}`);
      }
      
    } catch (error) {
      console.error(`❌ Error deleting session for user ${userId} at path ${sessionPath}:`, error);
      
      // Try alternative cleanup methods
      try {
        console.log(`🔄 Attempting alternative session cleanup for user ${userId}`);
        const files = await fs.readdir(sessionPath).catch(() => []);
        for (const file of files) {
          try {
            await fs.remove(path.join(sessionPath, file));
            console.log(`🗑️ Deleted session file: ${file} for user ${userId}`);
          } catch (fileError) {
            console.error(`❌ Failed to delete session file ${file} for user ${userId}:`, fileError);
          }
        }
        // Try to remove the directory itself
        await fs.rmdir(sessionPath).catch(() => {});
      } catch (altError) {
        console.error(`💥 Alternative session cleanup failed for user ${userId}:`, altError);
      }
      
      // Don't throw the error to allow other cleanup operations to continue
    }
  }

  isConnected() {
    return this.connected && this.sock;
  }

  extractGroupIdFromLink(groupLink) {
    try {
      if (!groupLink || typeof groupLink !== 'string') {
        return null;
      }
      
      // Remove whitespace and normalize
      const cleanLink = groupLink.trim();
      
      // Extract group invite code from various WhatsApp group link formats
      const regex = /(?:https?:\/\/)?(?:chat\.)?whatsapp\.com\/(?:invite\/)?([a-zA-Z0-9_-]{20,30})/i;
      const match = cleanLink.match(regex);
      
      if (match && match[1]) {
        console.log(`Extracted invite code: ${match[1]} from link: ${cleanLink}`);
        return match[1];
      }
      
      console.error('Invalid group link format:', cleanLink);
      return null;
    } catch (error) {
      console.error('Error extracting group ID:', error);
      return null;
    }
  }

  async bulkRemoveMembers(groupLinks) {
    if (!this.isConnected()) {
      throw new Error('WhatsApp not connected');
    }

    const results = {
      totalGroups: groupLinks.length,
      successCount: 0,
      failedJoins: [],
      totalMembersRemoved: 0,
      groupResults: []
    };

    console.log(`Starting bulk removal for ${groupLinks.length} groups`);

    for (let i = 0; i < groupLinks.length; i++) {
      const groupLink = groupLinks[i];
      const groupIndex = i + 1;
      
      try {
        // Validate group link format first
        if (!groupLink || typeof groupLink !== 'string' || !groupLink.includes('whatsapp.com')) {
          throw new Error('Invalid group link format');
        }

        // Emit progress update
        this.io.to(`user-${this.userId}`).emit('bulk-progress', {
          current: groupIndex,
          total: groupLinks.length,
          status: `Processing group ${groupIndex}/${groupLinks.length}`,
          groupLink: groupLink
        });

        console.log(`Processing group ${groupIndex}/${groupLinks.length}: ${groupLink}`);
        
        const result = await this.removeAllMembers(groupLink);
        
        results.successCount++;
        results.totalMembersRemoved += result.removed || 0;
        results.groupResults.push({
          groupLink,
          success: true,
          message: result.message,
          removed: result.removed || 0,
          total: result.total || 0
        });

        console.log(`✅ Group ${groupIndex} completed: ${result.removed || 0} members removed`);

      } catch (error) {
        const errorMessage = error.message || 'Unknown error';
        console.error(`❌ Error processing group ${groupIndex}: ${errorMessage}`);
        
        results.failedJoins.push({
          groupLink,
          error: errorMessage
        });
        
        results.groupResults.push({
          groupLink,
          success: false,
          error: errorMessage
        });

        // Emit error update
        this.io.to(`user-${this.userId}`).emit('bulk-progress', {
          current: groupIndex,
          total: groupLinks.length,
          status: `Error in group ${groupIndex}: ${errorMessage}`,
          groupLink: groupLink,
          error: true
        });
      }

      // Wait between groups to avoid rate limiting (increased to 3 seconds)
      if (i < groupLinks.length - 1) {
        console.log(`Waiting 3 seconds before processing next group...`);
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
    }

    console.log(`Bulk removal completed. Success: ${results.successCount}/${results.totalGroups}, Total removed: ${results.totalMembersRemoved}`);
    
    return results;
  }

  async removeAllMembers(groupLink) {
    if (!this.isConnected()) {
      throw new Error('WhatsApp not connected');
    }

    let groupId = null;
    
    try {
      const inviteCode = this.extractGroupIdFromLink(groupLink);
      if (!inviteCode) {
        throw new Error('Invalid WhatsApp group link format. Please use: https://chat.whatsapp.com/XXXXXXX');
      }

      console.log(`Processing invite code: ${inviteCode}`);

      // Step 1: Get group metadata from invite to extract group ID
      let groupInfoFromInvite;
      try {
        groupInfoFromInvite = await this.sock.groupGetInviteInfo(inviteCode);
        groupId = groupInfoFromInvite.id;
        console.log(`Group ID from invite: ${groupId}, Name: ${groupInfoFromInvite.subject}`);
      } catch (error) {
        console.error('Error getting group info from invite:', error);
        if (error.data === 404) {
          throw new Error('Invalid or expired group invite link.');
        } else {
          throw new Error('Unable to get group information from invite link. Please check the link and try again.');
        }
      }

      // Step 2: Try to fetch group metadata to check if we're already a member
      let groupMetadata;
      let isAlreadyMember = false;
      
      try {
        groupMetadata = await this.sock.groupMetadata(groupId);
        isAlreadyMember = true;
        console.log(`Already a member of group: ${groupMetadata.subject} (${groupId})`);
      } catch (error) {
        console.log(`Not a member of group yet, will attempt to join. Error: ${error.message}`);
        isAlreadyMember = false;
      }

      // Step 3: If not a member, try to join the group
      if (!isAlreadyMember) {
        try {
          console.log(`Attempting to join group with invite code: ${inviteCode}`);
          const joinResponse = await this.sock.groupAcceptInvite(inviteCode);
          console.log(`Successfully joined group: ${joinResponse}`);
          
          // Wait for group to be fully loaded after joining
          await new Promise(resolve => setTimeout(resolve, 3000));
          
          // Now fetch the group metadata
          try {
            groupMetadata = await this.sock.groupMetadata(groupId);
          } catch (metaError) {
            throw new Error('Successfully joined group but unable to fetch group metadata. Please try again.');
          }
          
        } catch (joinError) {
          console.error('Error joining group:', joinError);
          
          if (joinError.data === 403) {
            throw new Error('Bot must be added to group manually or made admin. Access denied to join via invite link.');
          } else if (joinError.data === 404) {
            throw new Error('Invalid or expired group invite link.');
          } else if (joinError.data === 409) {
            // Conflict - might already be member but not detected, try fetching metadata again
            try {
              groupMetadata = await this.sock.groupMetadata(groupId);
              console.log('Conflict resolved - was already a member');
            } catch (metaError) {
              throw new Error('Unable to join group. The invite link may have expired or you may already be a member.');
            }
          } else {
            throw new Error(`Failed to join group: ${joinError.message || 'Unknown error'}`);
          }
        }
      }
      
      // Validate that we have valid group metadata
      if (!groupMetadata) {
        throw new Error('Unable to access group metadata. Please ensure the invite link is valid.');
      }

      // Get group metadata with retry logic (reuse existing groupMetadata variable)
      let retries = 3;
      while (retries > 0) {
        try {
          groupMetadata = await this.sock.groupMetadata(groupId);
          break;
        } catch (error) {
          retries--;
          console.error(`Error fetching group metadata (retries left: ${retries}):`, error);
          if (retries === 0) {
            throw new Error(`Unable to fetch group information: ${error.message}`);
          }
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }
      
      if (!groupMetadata || !groupMetadata.participants) {
        throw new Error('Unable to fetch group participants. Please ensure you have access to this group.');
      }
      
      console.log(`Group: ${groupMetadata.subject}, Participants: ${groupMetadata.participants.length}`);
      
      // Get current user's JID and normalize it
      const currentUserJid = this.sock.user.id;
      
      // Enhanced normalization to handle different JID formats (@s.whatsapp.net, @lid, @g.us)
      const normalizeJid = (jid) => {
        // Remove port numbers, domain suffixes and extract the core identifier
        return jid.replace(/:\d+/, '').split('@')[0];
      };
      
      const normalizedCurrentJid = normalizeJid(currentUserJid);
      
      // Extract phone number from current user JID
      const extractPhoneNumber = (jid) => {
        const match = jid.match(/(\d{10,15})/);
        return match ? match[1] : null;
      };
      
      const currentUserPhone = extractPhoneNumber(currentUserJid);
      console.log(`Current user phone: ${currentUserPhone}`);
      
      // Check if current user is admin with enhanced matching for different JID formats
      let currentUserParticipant = groupMetadata.participants.find(p => {
        const normalizedPId = normalizeJid(p.id);
        
        // Direct exact match
        if (p.id === currentUserJid) return true;
        
        // Normalized match (core identifier comparison)
        if (normalizedPId === normalizedCurrentJid) return true;
        
        // Phone number based matching
        const participantPhone = extractPhoneNumber(p.id);
        
        if (currentUserPhone && participantPhone && currentUserPhone === participantPhone) return true;
        
        // Alternative matching for @lid format - check if participant ID contains current user's phone
        if (currentUserPhone && p.id.includes(currentUserPhone)) return true;
        
        // Reverse check - if current JID contains participant's phone number
        if (participantPhone && currentUserJid.includes(participantPhone)) return true;
        
        // Enhanced matching for Indian phone numbers and different formats
        if (p.id.includes('@lid')) {
          // Create comprehensive phone variations for Indian numbers
          const phoneVariations = [];
          
          // Add current user phone as-is
          if (currentUserPhone) {
            phoneVariations.push(currentUserPhone);
          }
          
          // Add session userId (admin phone number)
          if (this.userId) {
            phoneVariations.push(this.userId);
            phoneVariations.push('91' + this.userId); // India country code
            phoneVariations.push('1' + this.userId);  // Alternative format
          }
          
          // Add variations of current user phone
          if (currentUserPhone) {
            phoneVariations.push(currentUserPhone.substring(1)); // Remove first digit
            phoneVariations.push(currentUserPhone.substring(2)); // Remove first two digits
            phoneVariations.push('91' + currentUserPhone); // Add India country code
            phoneVariations.push('1' + currentUserPhone);  // Add US country code
          }
          
          // Try all variations
          for (const variation of phoneVariations) {
            if (variation && p.id.includes(variation)) {
              console.log(`Phone match found with variation: ${variation} in ${p.id}`);
              return true;
            }
          }
        }
        
        return false;
      });
      
