import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import chalk from 'chalk';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const config = JSON.parse(fs.readFileSync('config.json', 'utf8'));
const SLACK_API_URL = "https://slack.com/api/";

export async function getOnCallUsers() {
  try {
    console.log(chalk.blue('Fetching on-call users from PagerDuty...'));
    const response = await axios.get('https://api.pagerduty.com/oncalls', {
      headers: {
        "Authorization": `Token token=${config.pagerdutyApiToken}`,
        "Accept": "application/vnd.pagerduty+json;version=2"
      }
    });
    
    const oncalls = response.data.oncalls || [];
    const uniqueUsers = new Map();
    oncalls.forEach(oncall => {
      if (oncall.user && oncall.schedule && !config.skipSchedules.includes(oncall.schedule.id)) {
        uniqueUsers.set(oncall.user.id, oncall.user.summary);
      }
    });
    
    const users = Array.from(uniqueUsers.values());
    console.log(chalk.green('Found on-call users:', users.join(', ')));
    return users;
  } catch (error) {
    throw new Error(`Failed to get on-call users: ${error.message}`);
  }
}

export async function getCurrentGroupMembers() {
  try {
    const response = await axios.get(`${SLACK_API_URL}usergroups.users.list`, {
      params: { 
        usergroup: config.slackGroupId,
        include_disabled: true
      },
      headers: {
        'Authorization': `Bearer ${config.slackApiToken}`
      }
    });

    if (!response.data.ok) {
      throw new Error(`Failed to get group members: ${response.data.error}`);
    }

    const users = response.data.users || [];
    const userNames = [];
    
    // Get user details for each user ID
    for (const userId of users) {
      const userResponse = await axios.get(`${SLACK_API_URL}users.info`, {
        params: { user: userId },
        headers: {
          'Authorization': `Bearer ${config.slackApiToken}`
        }
      });
      if (userResponse.data.ok && userResponse.data.user) {
        userNames.push(userResponse.data.user.real_name);
      }
    }
    
    return userNames;
  } catch (error) {
    console.error(chalk.red(`Failed to get current group members: ${error.message}`));
    return [];
  }
}

export async function getSlackUserIdByName(name) {
  try {
    const response = await axios.get(`${SLACK_API_URL}users.list`, {
      headers: {
        'Authorization': `Bearer ${config.slackApiToken}`
      }
    });

    if (!response.data.ok) {
      throw new Error(`Failed to list users: ${response.data.error}`);
    }

    const user = response.data.members.find(member => 
      member.real_name === name || 
      member.name === name ||
      member.profile.real_name === name
    );

    return user ? user.id : null;
  } catch (error) {
    console.error(chalk.red(`Failed to get Slack ID for ${name}: ${error.message}`));
    return null;
  }
}

export async function updateGroupMembers(users) {
  try {
    // Get current members
    console.log(chalk.blue('Current group members:'));
    const currentMembers = await getCurrentGroupMembers();
    console.log(chalk.blue(currentMembers.join(', ') || 'None'));

    // Get Slack user IDs for each PagerDuty user
    console.log(chalk.blue('\nLooking up Slack IDs for users...'));
    const slackUserIds = [];
    for (const user of users) {
      const slackId = await getSlackUserIdByName(user);
      if (slackId) {
        slackUserIds.push(slackId);
        console.log(chalk.green(`Found Slack ID for ${user}: ${slackId}`));
      } else {
        console.log(chalk.yellow(`Could not find Slack ID for ${user}`));
      }
    }

    if (slackUserIds.length === 0) {
      console.log(chalk.yellow('No valid Slack user IDs found, skipping update'));
      return;
    }

    console.log(chalk.blue('\nUpdating Slack user group with:', users.join(', ')));
    await axios.post(`${SLACK_API_URL}usergroups.users.update`, {
      usergroup: config.slackGroupId,
      users: slackUserIds.join(',')
    }, {
      headers: {
        'Authorization': `Bearer ${config.slackApiToken}`,
        'Content-Type': 'application/json'
      }
    });

    // Get updated members
    console.log(chalk.blue('\nNew group members:'));
    const newMembers = await getCurrentGroupMembers();
    console.log(chalk.blue(newMembers.join(', ') || 'None'));

    console.log(chalk.green('Successfully updated Slack group members'));
  } catch (error) {
    throw new Error(`Failed to update group members: ${error.message}`);
  }
}

export async function updateSlackGroup() {
  try {
    console.log(chalk.yellow('Starting Slack group update...'));
    const users = await getOnCallUsers();
    if (users.length > 0) {
      // Post to Slack without @ mentions
      await axios.post(`${SLACK_API_URL}chat.postMessage`, {
        channel: config.slackChannelId,
        text: `:rotating_light: On-Call Update :rotating_light:\nCurrent on-call engineers:\n• ${users.join('\n• ')}`,
        link_names: false,  // Disable auto-linking of names
        mrkdwn: true
      }, {
        headers: {
          'Authorization': `Bearer ${config.slackApiToken}`,
          'Content-Type': 'application/json; charset=utf-8'
        }
      });

      // Update group members with all users
      await updateGroupMembers(users);
      console.log(chalk.green('✓ Slack user group update complete'));
    } else {
      console.log(chalk.yellow('No on-call users found'));
    }
  } catch (error) {
    console.error(chalk.red(`Failed to update Slack group: ${error.message}`));
  }
}

const isMainModule = process.argv[1] && 
  fileURLToPath(import.meta.url) === process.argv[1];

if (isMainModule) {
  (async () => {
    await updateSlackGroup();
  })();
}